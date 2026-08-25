import crypto from "node:crypto";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import RepairTrackingToken from "../models/RepairTrackingToken.js";
import AppError from "../utils/AppError.js";

const TRACKING_SCOPE = "repair:track";
const TOKEN_BYTES = 32;
const TOKEN_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30;

const unavailable = () => new AppError(
  "Repair tracking information is unavailable",
  404,
  [{ code: "repair_tracking_unavailable", message: "Check the repair reference and tracking credentials" }],
);

const secret = () => {
  if (!env.repairTrackingTokenSecret) {
    throw new AppError("Repair tracking is not configured", 503);
  }
  return env.repairTrackingTokenSecret;
};

export const isObjectId = (value) => typeof value === "string" && mongoose.isObjectIdOrHexString(value);

export const digestTrackingToken = (rawToken) => crypto
  .createHmac("sha256", secret())
  .update(rawToken)
  .digest("hex");

export const createTrackingToken = async (repairId, { session, now = new Date() } = {}) => {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + TOKEN_LIFETIME_MS);
  await RepairTrackingToken.create([{
    repair: repairId,
    digest: digestTrackingToken(rawToken),
    scope: TRACKING_SCOPE,
    issuedAt: now,
    expiresAt,
  }], { session });
  return { rawToken, expiresAt };
};

export const rotateTrackingToken = async (repairId, actorId, session) => {
  const now = new Date();
  await RepairTrackingToken.updateMany(
    { repair: repairId, scope: TRACKING_SCOPE, revokedAt: null },
    { $set: { revokedAt: now, revokedBy: actorId } },
    { session },
  );
  return createTrackingToken(repairId, { session, now });
};

export const authorizeScopedTrackingToken = async (repairId, rawToken) => {
  if (!rawToken || typeof rawToken !== "string" || rawToken.length > 512) throw unavailable();
  const token = await RepairTrackingToken.findOne({
    repair: repairId,
    digest: digestTrackingToken(rawToken),
    scope: TRACKING_SCOPE,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).select("_id").lean();
  if (!token) throw unavailable();
  return token;
};

export { unavailable as trackingUnavailable };
