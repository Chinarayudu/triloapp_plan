import jwt from "jsonwebtoken";
import { env } from "../config/env";

const ACCESS_TOKEN_TTL = "15m";

export type AccessTokenPayload = {
  sub: string;
  role: "user" | "host" | "admin" | "sub_admin";
};

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
}
