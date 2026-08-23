import { logger } from "./logger";

// No FCM credentials configured yet (BACKEND_PLAN.md's notification design
// calls for Firebase Cloud Messaging — same "stub now, wire in later"
// pattern as otpSender.ts/agoraToken.ts). Unlike OTP delivery, a missing
// push provider doesn't block the underlying feature — the message is
// already persisted and delivered live if the recipient is connected;
// push is a best-effort side channel for when they're not, so this never
// throws, even in production.
export async function sendPushNotification(userId: string, title: string, body: string): Promise<void> {
  logger.info({ userId, title, body }, "Push notification (dev mode — no FCM configured yet)");
}
