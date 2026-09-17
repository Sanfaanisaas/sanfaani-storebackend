import { createHash } from "node:crypto";
import Notification from "../models/Notification.js";
import NotificationDelivery from "../models/NotificationDelivery.js";
import PushDevice from "../models/PushDevice.js";
import User from "../models/User.js";
import { emailProvider } from "./providers/emailProvider.js";
import { pushProvider } from "./providers/pushProvider.js";
import { decryptPushToken, digestPushSecret } from "./pushDeviceService.js";
import { idText, pageInput, pagination } from "./customerDomainService.js";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 30_000;
let providers = { email: emailProvider, push: pushProvider };
let testHooks = {};

export const setNotificationProviders = (next = {}) => { providers = { ...providers, ...next }; };
export const setNotificationDeliveryTestHooks = (next = {}) => { testHooks = next; };

export const enqueueNotificationDeliveries = async ({ notification, channels, session }) => {
  if (testHooks.beforeEnqueue) await testHooks.beforeEnqueue({ notification, channels });
  const rows = channels.map((channel) => ({ notification: notification._id, recipient: notification.recipient, channel, status: "PENDING", nextAttemptAt: new Date() }));
  if (!rows.length) return [];
  try {
    return await NotificationDelivery.create(rows, session ? { session, ordered: true } : { ordered: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return NotificationDelivery.find({ notification: notification._id, channel: { $in: channels } }).session(session || null);
  }
};

const claimOne = (now) => NotificationDelivery.findOneAndUpdate({
  $or: [
    { status: "PENDING", nextAttemptAt: { $lte: now } },
    { status: "RETRY_SCHEDULED", nextAttemptAt: { $lte: now } },
    { status: "PROCESSING", lockedUntil: { $lte: now } },
  ],
}, { $set: { status: "PROCESSING", lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } }, { sort: { nextAttemptAt: 1, _id: 1 }, returnDocument: "after" });

const digestProviderId = (value) => createHash("sha256").update(String(value)).digest("hex");
const suppress = async (delivery, now) => {
  await NotificationDelivery.updateOne({ _id: delivery._id, status: "PROCESSING" }, { $set: { status: "SUPPRESSED", suppressedAt: now, lockedUntil: null, lastErrorCategory: "recipient_unavailable" } });
};

const deliverEmail = async (delivery, notification) => {
  const user = await User.findOne({ _id: delivery.recipient, status: "ACTIVE" }).select("email").lean();
  if (!user?.email) return null;
  return providers.email.send({ to: user.email, subject: notification.title, text: `${notification.safePreview}\n\n${notification.deepLink}`, idempotencyKey: idText(delivery._id) });
};
const deliverPush = async (delivery, notification) => {
  const devices = await PushDevice.find({ owner: delivery.recipient, active: true }).select("+tokenCiphertext +tokenIv +tokenTag +tokenDigest");
  if (!devices.length) return null;
  const tokens = devices.map(decryptPushToken);
  const result = await providers.push.send({ tokens, title: notification.title, body: notification.safePreview, deepLink: notification.deepLink, idempotencyKey: idText(delivery._id) });
  const invalidDigests = new Set((result.invalidTokens || []).map(digestPushSecret));
  if (invalidDigests.size) await PushDevice.updateMany({ owner: delivery.recipient, tokenDigest: { $in: [...invalidDigests] }, active: true }, { $set: { active: false, invalidatedAt: new Date() } });
  return { ...result, invalidatedDeviceCount: invalidDigests.size };
};

const processOne = async (delivery, now) => {
  const notification = await Notification.findById(delivery.notification).lean();
  if (!notification) { await suppress(delivery, now); return "suppressed"; }
  try {
    const result = delivery.channel === "email" ? await deliverEmail(delivery, notification) : await deliverPush(delivery, notification);
    if (!result) { await suppress(delivery, now); return "suppressed"; }
    await NotificationDelivery.updateOne({ _id: delivery._id, status: "PROCESSING" }, { $set: { status: "DELIVERED", deliveredAt: now, lockedUntil: null, lastErrorCategory: null, providerMessageDigest: digestProviderId(result.messageId || delivery._id), invalidatedDeviceCount: result.invalidatedDeviceCount || 0 } });
    return "delivered";
  } catch (error) {
    const retryable = error?.retryable !== false;
    const dead = !retryable || delivery.attempts >= MAX_ATTEMPTS;
    const category = retryable ? "provider_unavailable" : "provider_rejected";
    await NotificationDelivery.updateOne({ _id: delivery._id, status: "PROCESSING" }, { $set: dead
      ? { status: "DEAD_LETTER", deadLetteredAt: now, lockedUntil: null, lastErrorCategory: category }
      : { status: "RETRY_SCHEDULED", nextAttemptAt: new Date(now.getTime() + Math.min(60_000, 1000 * (2 ** (delivery.attempts - 1)))), lockedUntil: null, lastErrorCategory: category } });
    return dead ? "deadLettered" : "retried";
  }
};

export const processPendingDeliveries = async ({ limit = 50, now = new Date() } = {}) => {
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
  const result = { claimed: 0, delivered: 0, retried: 0, deadLettered: 0, suppressed: 0 };
  for (let index = 0; index < safeLimit; index += 1) {
    const delivery = await claimOne(now);
    if (!delivery) break;
    result.claimed += 1;
    result[await processOne(delivery, now)] += 1;
  }
  return result;
};

const deliveryDto = (item) => ({ id: idText(item._id), notificationId: idText(item.notification), channel: item.channel, status: item.status, attempts: item.attempts, nextAttemptAt: item.nextAttemptAt, deliveredAt: item.deliveredAt, suppressedAt: item.suppressedAt, deadLetteredAt: item.deadLetteredAt, lastErrorCategory: item.lastErrorCategory, invalidatedDeviceCount: item.invalidatedDeviceCount, createdAt: item.createdAt, updatedAt: item.updatedAt });
export const listNotificationDeliveries = async (query = {}) => {
  const { page, limit, skip } = pageInput(query);
  const filter = {};
  if (["PENDING", "PROCESSING", "RETRY_SCHEDULED", "DELIVERED", "SUPPRESSED", "DEAD_LETTER"].includes(query.status)) filter.status = query.status;
  if (["email", "push"].includes(query.channel)) filter.channel = query.channel;
  const [items, total] = await Promise.all([NotificationDelivery.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit), NotificationDelivery.countDocuments(filter)]);
  return { deliveries: items.map(deliveryDto), pagination: pagination(page, limit, total) };
};
