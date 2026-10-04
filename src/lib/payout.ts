import { createHmac, publicEncrypt, constants, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { env } from "../config/env";
import { logger } from "./logger";

// Host withdrawals via Cashfree Payouts (v2 Standard Transfer). A payout is
// asynchronous even at Cashfree — "initiated" means "accepted for processing",
// not "money moved". withdrawal.service.ts parks the request at `processing`
// and only the signed Payouts webhook or a status check (getPayoutOutcome)
// resolves it to paid/failed.
//
// Without Payouts keys (local dev/tests) this falls back to a logged dev stub
// that only POST /withdrawals/:id/dev-resolve-payout resolves; production
// refuses to run that way (a real host waiting on real money).
//
// Docs: https://www.cashfree.com/docs/api-reference/payouts/v2/transfers-v2/standard-transfer-v2
const PAYOUT_API_VERSION = "2024-01-01";
const DEV_STUB_PREFIX = "dev-payout-";

export type PayoutDetails =
  | { type: "upi"; vpa: string }
  | { type: "bank"; accountHolderName: string; accountNumber: string; ifsc: string };

export type PayoutOutcome = "pending" | "paid" | "failed" | "not_found";

export function isCashfreePayoutConfigured(): boolean {
  return Boolean(
    env.CASHFREE_PAYOUT_CLIENT_ID &&
      env.CASHFREE_PAYOUT_CLIENT_SECRET &&
      (env.CASHFREE_PAYOUT_PUBLIC_KEY || env.CASHFREE_PAYOUT_PUBLIC_KEY_PATH),
  );
}

// Our transfer id is derived from the withdrawal request id (Cashfree allows
// alphanumerics + "_" only, max 40), so a retry can never create a second
// transfer for the same request — Cashfree rejects the duplicate id.
export function payoutTransferId(withdrawalRequestId: string): string {
  return `wd_${withdrawalRequestId.replace(/-/g, "")}`;
}

export function isDevStubPayout(payoutTxnId: string | null): boolean {
  return payoutTxnId === null || payoutTxnId.startsWith(DEV_STUB_PREFIX);
}

function payoutBaseUrl(): string {
  return env.CASHFREE_ENV === "production" ? "https://api.cashfree.com/payout" : "https://sandbox.cashfree.com/payout";
}

function publicKey(): string {
  if (env.CASHFREE_PAYOUT_PUBLIC_KEY) return env.CASHFREE_PAYOUT_PUBLIC_KEY.replace(/\\n/g, "\n");
  if (env.CASHFREE_PAYOUT_PUBLIC_KEY_PATH) return readFileSync(env.CASHFREE_PAYOUT_PUBLIC_KEY_PATH, "utf8");
  throw new Error("Cashfree Payouts public key missing (CASHFREE_PAYOUT_PUBLIC_KEY or CASHFREE_PAYOUT_PUBLIC_KEY_PATH)");
}

// 2FA: RSA-OAEP(SHA-1) of "clientId.unixSeconds" with the account's public
// key, base64 — valid for 5 minutes, so it's generated fresh per request.
// https://www.cashfree.com/docs/payouts/payouts/integrations/payouts-2fa
function payoutHeaders(): Record<string, string> {
  if (!env.CASHFREE_PAYOUT_CLIENT_ID || !env.CASHFREE_PAYOUT_CLIENT_SECRET) {
    throw new Error("Cashfree Payouts is not configured (CASHFREE_PAYOUT_CLIENT_ID / CASHFREE_PAYOUT_CLIENT_SECRET)");
  }
  const signature = publicEncrypt(
    { key: publicKey(), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    Buffer.from(`${env.CASHFREE_PAYOUT_CLIENT_ID}.${Math.floor(Date.now() / 1000)}`),
  ).toString("base64");
  return {
    "x-api-version": PAYOUT_API_VERSION,
    "x-client-id": env.CASHFREE_PAYOUT_CLIENT_ID,
    "x-client-secret": env.CASHFREE_PAYOUT_CLIENT_SECRET,
    "x-cf-signature": signature,
    "Content-Type": "application/json",
  };
}

// Cashfree: "alphabets and whitespaces only, max 100".
function beneficiaryName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return cleaned || "Host";
}

export async function initiatePayout(params: {
  withdrawalRequestId: string;
  amountPaise: number;
  payoutDetails: string; // payoutMethods.detailsJson snapshot
  hostName: string;
}): Promise<{ payoutTxnId: string }> {
  if (!isCashfreePayoutConfigured()) {
    if (env.NODE_ENV === "production") {
      throw new Error("Cashfree Payouts is not configured — withdrawals can't run in production without it");
    }
    const payoutTxnId = `${DEV_STUB_PREFIX}${randomUUID()}`;
    logger.info({ ...params, payoutTxnId }, "Payout initiated (dev stub — Cashfree Payouts not configured)");
    return { payoutTxnId };
  }

  const details = JSON.parse(params.payoutDetails) as PayoutDetails;
  const transferId = payoutTransferId(params.withdrawalRequestId);
  const body =
    details.type === "upi"
      ? {
          transfer_id: transferId,
          transfer_amount: params.amountPaise / 100,
          transfer_mode: "upi",
          beneficiary_details: { beneficiary_name: beneficiaryName(params.hostName), beneficiary_instrument_details: { vpa: details.vpa } },
        }
      : {
          transfer_id: transferId,
          transfer_amount: params.amountPaise / 100,
          transfer_mode: "banktransfer",
          beneficiary_details: {
            beneficiary_name: beneficiaryName(details.accountHolderName || params.hostName),
            beneficiary_instrument_details: { bank_account_number: details.accountNumber, bank_ifsc: details.ifsc },
          },
        };

  const res = await fetch(`${payoutBaseUrl()}/transfers`, { method: "POST", headers: payoutHeaders(), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Cashfree Payouts transfer ${transferId} failed: ${res.status} ${text.slice(0, 300)}`);
  return { payoutTxnId: transferId };
}

// Terminal states per Cashfree v2: SUCCESS, or FAILED / REJECTED / REVERSED /
// MANUALLY_REJECTED. REVERSED can arrive after SUCCESS (the bank sent the
// money back), which is why "failed" can follow "paid".
export async function getPayoutOutcome(transferId: string): Promise<{ outcome: PayoutOutcome; description: string | null }> {
  const res = await fetch(`${payoutBaseUrl()}/transfers?transfer_id=${encodeURIComponent(transferId)}`, { headers: payoutHeaders() });
  const text = await res.text();
  if (res.status === 404) return { outcome: "not_found", description: null };
  if (!res.ok) throw new Error(`Cashfree Payouts status for ${transferId} failed: ${res.status} ${text.slice(0, 300)}`);

  const transfer = JSON.parse(text) as { status: string; status_description?: string };
  const description = transfer.status_description ?? null;
  if (transfer.status === "SUCCESS") return { outcome: "paid", description };
  if (["FAILED", "REJECTED", "REVERSED", "MANUALLY_REJECTED"].includes(transfer.status)) return { outcome: "failed", description };
  return { outcome: "pending", description };
}

// Payouts v2 webhooks: base64(HMAC-SHA256(timestamp + rawBody, Payouts client secret)).
// https://www.cashfree.com/docs/api-reference/payouts/v2/webhooks/webhooks-v2
export function isValidPayoutWebhookSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined): boolean {
  if (!timestamp || !signature || !env.CASHFREE_PAYOUT_CLIENT_SECRET) return false;
  const expected = createHmac("sha256", env.CASHFREE_PAYOUT_CLIENT_SECRET).update(timestamp + rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
