import crypto from "node:crypto";
import AppError from "../utils/AppError.js";
import { env } from "../config/env.js";

const ALLOWED = new Map([["image/jpeg", [".jpg", ".jpeg"]], ["image/png", [".png"]], ["application/pdf", [".pdf"]]]);
const detectedMime = (buffer) => {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
};
export const validateEvidenceFile = (file) => {
  if (!file?.buffer || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0 || file.buffer.length > 5 * 1024 * 1024) throw new AppError("Invalid evidence file", 400);
  const extension = `.${String(file.originalname || "").split(".").pop().toLowerCase()}`;
  const type = detectedMime(file.buffer);
  if (!type || file.mimetype !== type || !ALLOWED.get(type)?.includes(extension) || /\.(?:[a-z0-9]+\.)+(?:exe|js|html|svg|zip)$/i.test(file.originalname)) throw new AppError("Unsupported or unsafe evidence file", 400);
  return { detectedMimeType: type, checksum: crypto.createHash("sha256").update(file.buffer).digest("hex"), size: file.buffer.length, displayName: String(file.originalname).replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 160) };
};
export const generatedObjectKey = (subjectType, subjectId) => `private/${subjectType}/${subjectId}/${crypto.randomUUID()}`;
let adapter = null;
export const setEvidenceStorageAdapter = (nextAdapter) => { adapter = nextAdapter; };
export const memoryEvidenceStorageAdapter = () => { const objects = new Map(); return { async put(key, body) { objects.set(key, Buffer.from(body)); }, async remove(key) { objects.delete(key); }, async signedDownload(key, ttlSeconds) { if (!objects.has(key)) throw new AppError("Evidence is unavailable", 404); return { url: `memory://private/${key}`, expiresAt: new Date(Date.now() + ttlSeconds * 1000) }; } }; };
const activeAdapter = () => { if (adapter) return adapter; if (env.nodeEnv === "production") throw new AppError("Private evidence storage is not configured", 503); throw new AppError("Evidence storage adapter is unavailable", 503); };
export const putEvidenceObject = (key, body) => activeAdapter().put(key, body);
export const deleteEvidenceObject = (key) => activeAdapter().remove(key);
export const issueEvidenceDownload = (key, ttlSeconds = 300) => activeAdapter().signedDownload(key, ttlSeconds);
