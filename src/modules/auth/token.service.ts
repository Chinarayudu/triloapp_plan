import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { refreshTokens } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { sha256 } from "../../lib/hash";
import { AccessTokenPayload, signAccessToken } from "../../lib/jwt";
import { getUserById } from "../users/users.service";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type TokenPair = { accessToken: string; refreshToken: string };

export async function issueTokenPair(userId: string, role: AccessTokenPayload["role"]): Promise<TokenPair> {
  const accessToken = signAccessToken({ sub: userId, role });
  const refreshToken = randomBytes(32).toString("hex");

  await db.insert(refreshTokens).values({
    userId,
    tokenHash: sha256(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });

  return { accessToken, refreshToken };
}

// Rotation: the presented refresh token is revoked and replaced, even on
// success — a refresh token is single-use, so a stolen-and-replayed old
// token stops working the moment the legitimate client refreshes.
//
// Role/status are re-read from the user row rather than trusted from the
// old token, so a suspension applied mid-session takes effect on the next
// refresh instead of surviving until the old access token's own expiry.
export async function rotateRefreshToken(presentedToken: string): Promise<TokenPair> {
  const tokenHash = sha256(presentedToken);

  const [record] = await db
    .select()
    .from(refreshTokens)
    .where(
      and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())),
    )
    .limit(1);

  if (!record) {
    throw new AppError(401, "Invalid, expired, or already-used refresh token");
  }

  await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, record.id));

  const user = await getUserById(record.userId);
  if (!user || user.status !== "active") {
    throw new AppError(403, "Account is not active");
  }

  return issueTokenPair(user.id, user.role);
}

export async function revokeRefreshToken(presentedToken: string, userId: string): Promise<void> {
  const tokenHash = sha256(presentedToken);
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.tokenHash, tokenHash), eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}

// Used by admin.service.ts on suspend/ban (BR-ACC-05) — revokes every
// still-valid refresh token for this user at once, not just the one
// presented at logout, so the account can't be kept alive by refreshing
// from a different device/session.
export async function revokeAllRefreshTokensForUser(userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
}
