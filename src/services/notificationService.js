import Notification, { CUSTOMER_NOTIFICATION_RESOURCE_TYPES } from "../models/Notification.js";
import NotificationPreference, { OPTIONAL_NOTIFICATION_CATEGORIES } from "../models/NotificationPreference.js";
import { idText, pageInput, pagination, unavailable } from "./customerDomainService.js";
import { writeAuditLog } from "./auditService.js";

const dto = (item) => ({
  id: idText(item._id),
  type: item.type,
  title: item.title,
  safePreview: item.safePreview,
  resourceType: item.resourceType,
  resourceId: idText(item.resourceId),
  readAt: item.readAt,
  createdAt: item.createdAt,
  expiresAt: item.expiresAt,
  mandatory: item.mandatory,
});

export const createCustomerNotification = async ({ recipient, type, title, safePreview, resourceType, resourceId, mandatory = false, eventKey, session }) => {
  if (!CUSTOMER_NOTIFICATION_RESOURCE_TYPES.includes(resourceType)) throw new Error("Notification resource type must be allowlisted");
  const existing = await Notification.findOne({ recipient, eventKey }).session(session || null);
  if (existing) return { notification: existing, created: false };
  try {
    const [notification] = await Notification.create([{ recipient, type, title, safePreview, resourceType, resourceId, mandatory, eventKey }], session ? { session } : undefined);
    await writeAuditLog(recipient, "CUSTOMER_NOTIFICATION_CREATED", "Notification", notification._id, { type, resourceType }, session);
    return { notification, created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return { notification: await Notification.findOne({ recipient, eventKey }), created: false };
  }
};

export const listNotifications = async ({ recipient, query }) => {
  const { page, limit, skip } = pageInput(query);
  const filter = { recipient, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] };
  const [items, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);
  return { notifications: items.map(dto), pagination: pagination(page, limit, total) };
};

export const unreadCount = async (recipient) => Notification.countDocuments({ recipient, readAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });

export const markRead = async ({ recipient, id }) => {
  const notification = await Notification.findOneAndUpdate({ _id: id, recipient }, { $setOnInsert: {}, $set: { readAt: new Date() } }, { returnDocument: "after" });
  if (!notification) throw unavailable("Notification");
  return dto(notification);
};

export const markAllRead = async ({ recipient }) => {
  const result = await Notification.updateMany({ recipient, readAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }, { $set: { readAt: new Date() } });
  await writeAuditLog(recipient, "CUSTOMER_NOTIFICATIONS_READ", "Notification", recipient, { count: Math.min(result.modifiedCount, 500) });
  return { marked: Math.min(result.modifiedCount, 500) };
};

const preferenceDto = (preference) => ({
  version: preference.version,
  mandatoryCategories: ["security", "transactional"],
  optionalCategories: Object.fromEntries(OPTIONAL_NOTIFICATION_CATEGORIES.map((key) => [key, Boolean(preference.optionalCategories?.[key])])),
  channels: { inApp: Boolean(preference.channels?.inApp), email: false, sms: false, push: false },
});

export const getPreferences = async (recipient) => {
  const preference = await NotificationPreference.findOneAndUpdate({ recipient }, { $setOnInsert: { recipient } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return preferenceDto(preference);
};

export const updatePreferences = async ({ recipient, input }) => {
  const allowed = new Set(OPTIONAL_NOTIFICATION_CATEGORIES);
  const updates = {};
  for (const [key, value] of Object.entries(input?.optionalCategories || {})) {
    if (!allowed.has(key) || typeof value !== "boolean") throw new Error("Invalid optional notification preference");
    updates[`optionalCategories.${key}`] = value;
  }
  if (Object.keys(updates).length) await NotificationPreference.updateOne({ recipient }, { $setOnInsert: { recipient }, $set: updates }, { upsert: true, setDefaultsOnInsert: true });
  return getPreferences(recipient);
};
