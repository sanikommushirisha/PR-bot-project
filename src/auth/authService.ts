import { timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config/env.js";

const TOKEN_EXPIRY = "12h";

/** Constant-time compare so a wrong-guess login can't be timed to leak how many leading characters matched. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** There's exactly one valid login — a hardcoded username/password pair from env, not a user database. */
export function verifyCredentials(username: string, password: string): boolean {
  return safeEqual(username, config.dashboard.username) && safeEqual(password, config.dashboard.password);
}

export function signToken(username: string): string {
  return jwt.sign({ sub: username }, config.dashboard.jwtSecret, { expiresIn: TOKEN_EXPIRY });
}

/** Returns the token subject on success, or null for any failure (expired, malformed, wrong signature). */
export function verifyToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, config.dashboard.jwtSecret);
    if (typeof payload === "object" && typeof payload.sub === "string") {
      return payload.sub;
    }
    return null;
  } catch {
    return null;
  }
}
