import jwt from "jsonwebtoken";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

export const ACCESS_TOKEN_EXPIRY = "15m";
export const REFRESH_TOKEN_EXPIRY = "30d";
export const REFRESH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function generateAccessToken(user) {
  return jwt.sign(
    { userId: user._id, role: user.role },
    env.jwtSecret,
    { expiresIn: ACCESS_TOKEN_EXPIRY, jwtid: randomUUID() }
  );
}

export function generateRefreshToken({ userId, sessionId, familyId, jti }) {
  return jwt.sign(
    { userId, sessionId, familyId, jti, type: "refresh" },
    env.jwtRefreshSecret,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
}

export function digestRefreshToken(token) {
  return createHmac("sha256", env.jwtRefreshSecret).update(token).digest("hex");
}

export function refreshTokenDigestMatches(token, expectedDigest) {
  const actual = Buffer.from(digestRefreshToken(token), "hex");
  const expected = Buffer.from(String(expectedDigest || ""), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtSecret);
}

export function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, env.jwtRefreshSecret);
  if (decoded.type !== "refresh") throw new Error("Invalid token type");
  return decoded;
}

export function verifyRefreshTokenIgnoringExpiry(token) {
  const decoded = jwt.verify(token, env.jwtRefreshSecret, { ignoreExpiration: true });
  if (decoded.type !== "refresh") throw new Error("Invalid token type");
  return decoded;
}
