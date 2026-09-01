import crypto from "node:crypto";
import mongoose from "mongoose";
import Evidence from "../models/Evidence.js";
import AppError from "../utils/AppError.js";

export const isObjectId = (value) => typeof value === "string" && mongoose.isObjectIdOrHexString(value);
export const unavailable = (resource = "Resource") => new AppError(
  `${resource} is unavailable`,
  404,
  [{ code: `${resource.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_unavailable`, message: "Check the reference and account" }],
);
export const conflict = (code, message) => new AppError(message, 409, [{ code, message }]);
export const badInput = (field, message) => new AppError("Request validation failed", 400, [{ field, code: "validation", message }]);
export const requireIdempotencyKey = (value) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 128) throw badInput("Idempotency-Key", "Provide an Idempotency-Key of at most 128 characters");
  return value.trim();
};
export const fingerprint = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const idText = (value) => value?.toString?.() || String(value);
export const pageInput = (query = {}) => {
  const rawPage = Number(query.page ?? 1); const rawLimit = Number(query.limit ?? 20);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20;
  return { page, limit, skip: (page - 1) * limit };
};
export const pagination = (page, limit, total) => ({ page, limit, total, pages: Math.ceil(total / limit), hasNextPage: page * limit < total });

const evidenceDto = (evidence) => ({
  id: idText(evidence._id),
  purpose: evidence.purpose,
  displayName: evidence.displayName,
  detectedMimeType: evidence.detectedMimeType,
  size: evidence.size,
  retentionState: evidence.retentionState,
  createdAt: evidence.createdAt,
});

export const listEvidenceSummaries = async ({ owner, subjectType, subject }) => {
  const items = await Evidence.find({ owner, subjectType, subject, retentionState: { $ne: "DELETED" } })
    .select("_id purpose displayName detectedMimeType size retentionState createdAt").sort({ createdAt: -1 }).lean();
  return items.map(evidenceDto);
};

export const documentMetadata = (evidence) => evidence ? ({
  id: idText(evidence._id),
  displayName: evidence.displayName,
  detectedMimeType: evidence.detectedMimeType,
  issuedAt: evidence.createdAt,
}) : null;
