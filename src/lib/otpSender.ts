import twilio from "twilio";
import { env } from "../config/env";
import { logger } from "./logger";

const twilioConfigured = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
const twilioClient = twilioConfigured ? twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) : undefined;

// Real sending is gated on more than just "are credentials configured":
// - test: never real, no exceptions — random test phone numbers aren't
//   real destinations, and a test suite shouldn't depend on (or pay for)
//   an external call.
// - production: always real if configured, loud failure if not — never a
//   silent no-op with real users depending on it.
// - development: real ONLY with an explicit opt-in (OTP_REAL_SMS_IN_DEV).
//   Just having credentials present doesn't imply intent — local/manual
//   smoke testing routinely uses made-up phone numbers, and this account
//   is a Twilio trial (can only reach numbers verified in their console).
export async function sendOtp(phone: string, code: string): Promise<void> {
  const shouldSendReal =
    twilioClient && env.NODE_ENV !== "test" && (env.NODE_ENV === "production" || env.OTP_REAL_SMS_IN_DEV);

  if (shouldSendReal) {
    await twilioClient!.messages.create({
      body: `Your TriloPlan verification code is ${code}. It expires in 5 minutes.`,
      from: env.TWILIO_PHONE_NUMBER,
      to: phone,
    });
    return;
  }

  if (env.NODE_ENV === "production") {
    throw new Error("No OTP SMS provider configured for production");
  }

  logger.info({ phone, code }, "OTP (dev mode — real SMS not enabled for this environment)");
}
