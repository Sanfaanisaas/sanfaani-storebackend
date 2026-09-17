import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import PushDevice from "../models/PushDevice.js";
import AppError from "../utils/AppError.js";
import { conflict, fingerprint, idText, isObjectId, requireIdempotencyKey, unavailable } from "./customerDomainService.js";
import { env } from "../config/env.js";
import { writeAuditLog } from "./auditService.js";

const keyBuffer = () => {
  if (!env.pushTokenEncryptionKey) throw new AppError("Push device service unavailable", 503, [{ code: "push_configuration_missing", message: "Push notifications are not configured" }]);
  return Buffer.from(env.pushTokenEncryptionKey, "hex");
};
export const digestPushSecret = (value) => createHmac("sha256", keyBuffer()).update(value).digest("hex");
const encrypt = (token) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuffer(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { tokenCiphertext: ciphertext.toString("base64"), tokenIv: iv.toString("base64"), tokenTag: cipher.getAuthTag().toString("base64") };
};
export const decryptPushToken = (device) => {
  const decipher = createDecipheriv("aes-256-gcm", keyBuffer(), Buffer.from(device.tokenIv, "base64"));
  decipher.setAuthTag(Buffer.from(device.tokenTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(device.tokenCiphertext, "base64")), decipher.final()]).toString("utf8");
};

const dto = (device) => ({ id: idText(device._id), platform: device.platform, label: device.label, active: device.active, lastSeenAt: device.lastSeenAt, createdAt: device.createdAt, updatedAt: device.updatedAt });

export const registerPushDevice = async ({ owner, input, idempotencyKey }) => {
  const key = requireIdempotencyKey(idempotencyKey);
  const normalized = { deviceId: input.deviceId.trim(), pushToken: input.pushToken.trim(), platform: input.platform, label: input.label.trim() };
  const hash = fingerprint(normalized);
  const replay = await PushDevice.findOne({ owner, idempotencyKey: key }).select("+idempotencyFingerprint");
  if (replay) {
    if (replay.idempotencyFingerprint !== hash) throw conflict("push_device_idempotency_conflict", "This idempotency key is associated with different device data");
    return { created: false, device: dto(replay) };
  }
  const deviceIdDigest = digestPushSecret(normalized.deviceId);
  const tokenDigest = digestPushSecret(normalized.pushToken);
  const encrypted = encrypt(normalized.pushToken);
  const existing = await PushDevice.findOne({ owner, deviceIdDigest }).select("+deviceIdDigest +idempotencyKey +idempotencyFingerprint");
  try {
    if (existing) {
      Object.assign(existing, { platform: normalized.platform, label: normalized.label, tokenDigest, ...encrypted, active: true, invalidatedAt: null, revokedAt: null, lastSeenAt: new Date(), idempotencyKey: key, idempotencyFingerprint: hash });
      await existing.save();
      await writeAuditLog(owner, "PUSH_DEVICE_REGISTERED", "PushDevice", existing._id, { platform: existing.platform, rotated: true });
      return { created: false, device: dto(existing) };
    }
    const device = await PushDevice.create({ owner, platform: normalized.platform, label: normalized.label, deviceIdDigest, tokenDigest, ...encrypted, idempotencyKey: key, idempotencyFingerprint: hash });
    await writeAuditLog(owner, "PUSH_DEVICE_REGISTERED", "PushDevice", device._id, { platform: device.platform, rotated: false });
    return { created: true, device: dto(device) };
  } catch (error) {
    if (error?.code === 11000) throw conflict("push_device_conflict", "This push device or token is already registered");
    throw error;
  }
};

export const listPushDevices = async (owner) => (await PushDevice.find({ owner }).sort({ updatedAt: -1 })).map(dto);
export const revokePushDevice = async ({ owner, id }) => {
  if (!isObjectId(id)) throw unavailable("Push device");
  const device = await PushDevice.findOneAndUpdate({ _id: id, owner, active: true }, { $set: { active: false, revokedAt: new Date() } }, { returnDocument: "after" });
  if (!device) throw unavailable("Push device");
  await writeAuditLog(owner, "PUSH_DEVICE_REVOKED", "PushDevice", device._id, { reason: "customer_revoked" });
  return dto(device);
};
export const revokePushDeviceByIdentifier = async ({ owner, deviceId, reason = "logout" }) => {
  if (!owner || typeof deviceId !== "string" || !deviceId.trim() || !env.pushTokenEncryptionKey) return false;
  const device = await PushDevice.findOneAndUpdate({ owner, deviceIdDigest: digestPushSecret(deviceId.trim()), active: true }, { $set: { active: false, revokedAt: new Date() } }, { returnDocument: "after" });
  if (!device) return false;
  await writeAuditLog(owner, "PUSH_DEVICE_REVOKED", "PushDevice", device._id, { reason });
  return true;
};
