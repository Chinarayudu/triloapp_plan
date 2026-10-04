import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env";

// Cashfree Payment Gateway (wallet recharge + VIP checkout). Flow, per
// BACKEND_PLAN.md §2: we create an order here, the User app opens Cashfree's
// checkout with the returned payment_session_id, and money is only credited
// after we re-read the order from Cashfree and see it PAID — whether that's
// prompted by the signed webhook or by the app checking status. The webhook
// body itself is never trusted for amounts or status.
//
// Docs: https://www.cashfree.com/docs/api-reference/payments/latest/orders/create
const PG_API_VERSION = "2025-01-01";

export type CashfreeOrderStatus = "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED" | "TERMINATION_REQUESTED";

export type CashfreeOrder = {
  order_id: string;
  cf_order_id: string;
  order_amount: number; // rupees, up to 2 decimals
  order_currency: string;
  order_status: CashfreeOrderStatus;
  payment_session_id: string;
};

export function isCashfreePgConfigured(): boolean {
  return Boolean(env.CASHFREE_PG_APP_ID && env.CASHFREE_PG_SECRET_KEY);
}

// The Cashfree checkout SDK in the User app needs the matching mode.
export function cashfreeCheckoutMode(): "sandbox" | "production" {
  return env.CASHFREE_ENV;
}

function pgBaseUrl(): string {
  return env.CASHFREE_ENV === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
}

function pgHeaders(): Record<string, string> {
  if (!env.CASHFREE_PG_APP_ID || !env.CASHFREE_PG_SECRET_KEY) {
    throw new Error("Cashfree PG is not configured (CASHFREE_PG_APP_ID / CASHFREE_PG_SECRET_KEY)");
  }
  return {
    "x-api-version": PG_API_VERSION,
    "x-client-id": env.CASHFREE_PG_APP_ID,
    "x-client-secret": env.CASHFREE_PG_SECRET_KEY,
    "Content-Type": "application/json",
  };
}

async function pgRequest(method: "GET" | "POST", path: string, body?: unknown): Promise<CashfreeOrder> {
  const res = await fetch(`${pgBaseUrl()}${path}`, {
    method,
    headers: pgHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // Loud on purpose — a failed order create/lookup must never look like success.
    throw new Error(`Cashfree PG ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as CashfreeOrder;
}

export async function createCashfreeOrder(params: {
  orderId: string;
  amountPaise: number;
  customerId: string;
  customerPhone: string;
  returnUrl: string;
}): Promise<CashfreeOrder> {
  return pgRequest("POST", "/orders", {
    order_id: params.orderId,
    order_amount: params.amountPaise / 100,
    order_currency: "INR",
    customer_details: { customer_id: params.customerId, customer_phone: params.customerPhone },
    order_meta: {
      return_url: params.returnUrl,
      ...(env.BACKEND_PUBLIC_URL ? { notify_url: `${env.BACKEND_PUBLIC_URL}/payments/cashfree/webhook` } : {}),
    },
  });
}

export async function getCashfreeOrder(orderId: string): Promise<CashfreeOrder> {
  return pgRequest("GET", `/orders/${encodeURIComponent(orderId)}`);
}

// Cashfree signs base64(HMAC-SHA256(timestamp + rawBody, PG secret key)) — over
// the exact raw bytes received, so this must run before any JSON parsing.
// https://www.cashfree.com/docs/payments/online/webhooks/signature-verification
export function isValidCashfreeWebhookSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined): boolean {
  if (!timestamp || !signature || !env.CASHFREE_PG_SECRET_KEY) return false;
  const expected = createHmac("sha256", env.CASHFREE_PG_SECRET_KEY).update(timestamp + rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Cashfree wants a 3–50 char alphanumeric customer id and a 10-digit phone;
// our ids are UUIDs and phones are E.164 (+91XXXXXXXXXX).
export function cashfreeCustomerId(userId: string): string {
  return `u${userId.replace(/-/g, "")}`;
}

export function cashfreeCustomerPhone(e164Phone: string): string {
  return e164Phone.replace(/\D/g, "").slice(-10);
}
