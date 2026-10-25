import { cert, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { env } from "../config/env";
import { AppError } from "./errors";
import { logger } from "./logger";

// Firebase Phone Auth (same approach as homey_backend): the app runs the whole
// OTP flow with the Firebase client SDK — Firebase sends the SMS — and then
// sends us the ID token it got. We verify that token and trust the phone
// number Firebase vouches for. No OTP is generated, stored or sent here.

let app: App | null = null;

function firebaseApp(): App {
  if (app) return app;
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    throw new AppError(503, "Firebase phone login isn't configured on the server");
  }
  app = initializeApp(
    {
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        // Hosts like Render store it with literal \n escapes.
        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    },
    "triloplan-phone-auth",
  );
  return app;
}

// The E.164 phone number (e.g. +919876543210) the token was issued for.
export async function verifyFirebasePhoneToken(idToken: string): Promise<string> {
  const auth = getAuth(firebaseApp());
  let decoded;
  try {
    decoded = await auth.verifyIdToken(idToken);
  } catch (err) {
    logger.warn({ err }, "Rejected a Firebase ID token");
    throw new AppError(401, "Invalid or expired Firebase token — verify the phone number again");
  }
  if (!decoded.phone_number) {
    throw new AppError(400, "This Firebase token wasn't issued for phone sign-in");
  }
  return decoded.phone_number;
}
