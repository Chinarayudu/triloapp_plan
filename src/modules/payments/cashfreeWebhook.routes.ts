import express, { Router } from "express";
import { isValidCashfreeWebhookSignature } from "../../lib/cashfree";
import { logger } from "../../lib/logger";
import { isValidPayoutWebhookSignature, isValidPayoutWebhookV1Signature } from "../../lib/payout";
import { getRechargeTxnByGatewayOrderId, syncRechargeWithGateway } from "../wallet/recharge.service";
import { getWithdrawalByPayoutTxnId, syncPayoutWithGateway } from "../withdrawals/withdrawal.service";
import { getVipPurchaseByGatewayOrderId, syncVipPurchaseWithGateway } from "../wallet/vip.service";

export const cashfreeWebhookRouter = Router();

// Cashfree PG webhook (the order's notify_url). Mounted in app.ts BEFORE
// express.json(): the signature covers the exact raw bytes, so the body must
// reach us unparsed. The payload is only used to find which order to look at —
// syncRecharge/VipPurchase re-read the order from Cashfree and settle from
// that, so a replayed or reordered webhook can't credit anything twice or
// credit an unpaid order.
//
// Response codes matter: any non-2xx makes Cashfree retry, so a real failure
// (DB down, Cashfree lookup failing) returns 500 to get a retry, while a
// webhook for an order we don't know returns 200 so it isn't retried forever.
cashfreeWebhookRouter.post("/payments/cashfree/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const timestamp = req.header("x-webhook-timestamp");
  const signature = req.header("x-webhook-signature");
  if (!isValidCashfreeWebhookSignature(rawBody, timestamp, signature)) {
    logger.warn({ path: req.path }, "Rejected Cashfree webhook with an invalid signature");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let orderId: unknown;
  let type: unknown;
  try {
    const payload = JSON.parse(rawBody);
    orderId = payload?.data?.order?.order_id;
    type = payload?.type;
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }
  if (typeof orderId !== "string") {
    logger.info({ type }, "Cashfree webhook without an order id — ignored");
    res.json({ ok: true });
    return;
  }

  try {
    if (orderId.startsWith("rch_")) {
      const txn = await getRechargeTxnByGatewayOrderId(orderId);
      if (txn) {
        const settled = await syncRechargeWithGateway(txn);
        logger.info({ type, orderId, status: settled.status }, "Cashfree webhook processed (recharge)");
      } else {
        logger.warn({ type, orderId }, "Cashfree webhook for an unknown recharge order — ignored");
      }
    } else if (orderId.startsWith("vip_")) {
      const purchase = await getVipPurchaseByGatewayOrderId(orderId);
      if (purchase) {
        const settled = await syncVipPurchaseWithGateway(purchase);
        logger.info({ type, orderId, status: settled.status }, "Cashfree webhook processed (VIP)");
      } else {
        logger.warn({ type, orderId }, "Cashfree webhook for an unknown VIP order — ignored");
      }
    } else {
      logger.warn({ type, orderId }, "Cashfree webhook for an order id we don't issue — ignored");
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, type, orderId }, "Cashfree webhook processing failed — Cashfree will retry");
    res.status(500).json({ error: "Processing failed" });
  }
});

// Cashfree Payouts webhook (host withdrawals) — configured in the Payouts
// dashboard, not per transfer. Accepts both versions the dashboard can send:
// V2 (JSON, signature in headers) and V1 (JSON or form, signature in the body),
// both signed with the Payouts client secret, not the PG one. Same rules as
// above: verify, use the payload only to find the request, settle from
// Cashfree's own transfer status.
cashfreeWebhookRouter.post("/payments/cashfree/payout-webhook", express.raw({ type: "*/*" }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const contentType = req.header("content-type") ?? "";

  // The body as fields — JSON or form-encoded (V1 can be either).
  let fields: Record<string, any>;
  try {
    fields = contentType.includes("application/x-www-form-urlencoded")
      ? Object.fromEntries(new URLSearchParams(rawBody))
      : JSON.parse(rawBody);
  } catch {
    logger.warn({ contentType }, "Rejected Cashfree Payouts webhook with an unparseable body");
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  // V2 signs in headers; V1 (legacy, and the dashboard's test) signs in the body.
  const v2Signature = req.header("x-webhook-signature");
  const valid = v2Signature
    ? isValidPayoutWebhookSignature(rawBody, req.header("x-webhook-timestamp"), v2Signature)
    : isValidPayoutWebhookV1Signature(fields);
  if (!valid) {
    logger.warn(
      {
        contentType,
        hasV2SignatureHeader: Boolean(v2Signature),
        hasV2TimestampHeader: Boolean(req.header("x-webhook-timestamp")),
        hasV1SignatureField: typeof fields?.signature === "string",
        fieldNames: fields && typeof fields === "object" ? Object.keys(fields) : [],
        event: fields?.type ?? fields?.event,
      },
      "Rejected Cashfree Payouts webhook with an invalid signature",
    );
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  const transferId: unknown = v2Signature ? fields?.data?.transfer_id : fields.transferId;
  const type: unknown = v2Signature ? fields?.type : fields.event;
  if (typeof transferId !== "string") {
    logger.info({ type }, "Cashfree Payouts webhook without a transfer id (e.g. balance alert) — ignored");
    res.json({ ok: true });
    return;
  }

  try {
    const request = await getWithdrawalByPayoutTxnId(transferId);
    if (request) {
      const settled = await syncPayoutWithGateway(request);
      logger.info({ type, transferId, status: settled.status }, "Cashfree Payouts webhook processed");
    } else {
      logger.warn({ type, transferId }, "Cashfree Payouts webhook for an unknown transfer — ignored");
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, type, transferId }, "Cashfree Payouts webhook processing failed — Cashfree will retry");
    res.status(500).json({ error: "Processing failed" });
  }
});
