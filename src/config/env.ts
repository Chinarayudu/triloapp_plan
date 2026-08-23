import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  // How often the real background timers fire — deliberately separate
  // from the fixed 10s billing-tick unit (calls.service.ts's
  // TICK_INTERVAL_MS), which is a business constant, not an ops knob:
  // conflating the two once meant overriding the scheduler cadence for
  // tests silently changed how much a tick actually costs. Tests override
  // these to a value the run will never reach and drive ticks
  // deterministically via direct calls instead — see vitest.config.ts.
  CALL_SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  CALL_RINGING_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Optional as a group — otpSender.ts falls back to dev-mode logging when
  // any of these is missing. All three or none; there's no valid
  // partially-configured state.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  // Explicit opt-in, off by default: having Twilio credentials configured
  // does NOT by itself mean every dev-server request should send a real
  // SMS — local/manual smoke testing routinely uses made-up phone numbers,
  // and this Twilio account is a trial (can only reach numbers verified in
  // the Twilio console). Flip this on deliberately when testing against a
  // real, verified number. Always on in production, always off in tests,
  // regardless of this flag.
  //
  // z.coerce.boolean() is NOT used here on purpose — it coerces via
  // Boolean(str), under which the string "false" is truthy, silently
  // inverting anyone's intent to turn this off.
  OTP_REAL_SMS_IN_DEV: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Optional as a group, same convention as the Twilio vars above — object
  // storage (KYC uploads) simply isn't available if these are missing;
  // s3.ts fails loudly on first use rather than pretending to work.
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_REGION: z.string().optional(),
  AWS_S3_BUCKET_NAME: z.string().optional(),
  // Optional as a group, same convention — agoraToken.ts falls back to a
  // clearly-fake stub token when these are missing rather than failing,
  // since call flows still need to be buildable/testable without a real
  // Agora project configured.
  AGORA_APP_ID: z.string().optional(),
  AGORA_APP_CERTIFICATE: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
