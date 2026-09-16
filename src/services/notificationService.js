import mongoose from "mongoose";
import Notification, { CUSTOMER_NOTIFICATION_RESOURCE_TYPES } from "../models/Notification.js";
import NotificationPreference, { OPTIONAL_NOTIFICATION_CATEGORIES } from "../models/NotificationPreference.js";
import { enqueueNotificationDeliveries } from "./notificationDeliveryService.js";
import { idText, pageInput, pagination, unavailable } from "./customerDomainService.js";
import AppError from "../utils/AppError.js";
import { writeAuditLog } from "./auditService.js";

const CATEGORY_BY_RESOURCE = Object.freeze({ repair: "repair_updates", claim: "claims_returns", return: "claims_returns", support_ticket: "support_updates", guidance: "guidance_updates", procurement_request: "procurement_updates", procurement_quotation: "procurement_updates", service_request: "service_updates", service_quotation: "service_updates", maintenance_plan: "service_updates" });
const DEEP_LINK_PREFIX = Object.freeze({ repair: "/repairs", claim: "/claims", return: "/returns", support_ticket: "/support", guidance: "/guidance", procurement_request: "/procurement/requests", procurement_quotation: "/procurement/quotations", service_request: "/services/requests", service_quotation: "/services/quotations", maintenance_plan: "/maintenance-plans" });
const mandatoryType = (type) => /^(security|payment|order)_/.test(type);
const deepLinkFor = (resourceType, resourceId) => `${DEEP_LINK_PREFIX[resourceType]}/${idText(resourceId)}`;

const dto = (item) => ({ id: idText(item._id), type: item.type, title: item.title, safePreview: item.safePreview, resourceType: item.resourceType, resourceId: idText(item.resourceId), deepLink: item.deepLink, readAt: item.readAt, createdAt: item.createdAt, expiresAt: item.expiresAt, mandatory: item.mandatory });
const preferenceDto = (preference) => ({ version: preference.version, mandatoryCategories: ["security", "transactional"], optionalCategories: Object.fromEntries(OPTIONAL_NOTIFICATION_CATEGORIES.map((key) => [key, Boolean(preference.optionalCategories?.[key])])), channels: { inApp: true, email: Boolean(preference.channels?.email), sms: false, push: Boolean(preference.channels?.push) } });
const getOrCreatePreference = (recipient, session) => NotificationPreference.findOneAndUpdate({ recipient }, { $setOnInsert: { recipient } }, { upsert: true, new: true, setDefaultsOnInsert: true, session });

export const createCustomerNotification = async ({ recipient, type, title, safePreview, resourceType, resourceId, mandatory = false, eventKey, session }) => {
  if (!CUSTOMER_NOTIFICATION_RESOURCE_TYPES.includes(resourceType)) throw new Error("Notification resource type must be allowlisted");
  const useSession = session || await mongoose.startSession();
  const ownsSession = !session;
  try {
    const work = async () => {
      const existing = await Notification.findOne({ recipient, eventKey }).session(useSession);
      if (existing) return { notification: existing, created: false, suppressed: false };
      const preference = await getOrCreatePreference(recipient, useSession);
      const category = CATEGORY_BY_RESOURCE[resourceType];
      const isMandatory = Boolean(mandatory || mandatoryType(type));
      if (!isMandatory && !preference.optionalCategories?.[category]) return { notification: null, created: false, suppressed: true };
      const [notification] = await Notification.create([{ recipient, type, title, safePreview, resourceType, resourceId, mandatory: isMandatory, category, deepLink: deepLinkFor(resourceType, resourceId), eventKey }], { session: useSession });
      await writeAuditLog(recipient, "CUSTOMER_NOTIFICATION_CREATED", "Notification", notification._id, { type, resourceType }, useSession);
      const channels = isMandatory ? ["email", "push"] : [...(preference.channels?.email ? ["email"] : []), ...(preference.channels?.push ? ["push"] : [])];
      await enqueueNotificationDeliveries({ notification, channels, session: useSession });
      return { notification, created: true, suppressed: false };
    };
    return ownsSession ? await useSession.withTransaction(work) : await work();
  } finally { if (ownsSession) await useSession.endSession(); }
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
  if (!idText(id).match(/^[a-fA-F0-9]{24}$/)) throw unavailable("Notification");
  const notification = await Notification.findOneAndUpdate({ _id: id, recipient }, { $set: { readAt: new Date() } }, { returnDocument: "after" });
  if (!notification) throw unavailable("Notification");
  return dto(notification);
};

export const markAllRead = async ({ recipient }) => {
  const result = await Notification.updateMany({ recipient, readAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }, { $set: { readAt: new Date() } });
  await writeAuditLog(recipient, "CUSTOMER_NOTIFICATIONS_READ", "Notification", recipient, { count: Math.min(result.modifiedCount, 500) });
  return { marked: Math.min(result.modifiedCount, 500) };
};

export const getPreferences = async (recipient) => preferenceDto(await getOrCreatePreference(recipient));

export const updatePreferences = async ({ recipient, input }) => {
  if (input?.mandatoryCategories !== undefined) throw new AppError("Mandatory notification categories cannot be changed", 422, [{ code: "mandatory_preference_immutable", message: "Security and transactional notices are always enabled" }]);
  const updates = { consentUpdatedAt: new Date() };
  for (const [key, value] of Object.entries(input?.optionalCategories || {})) {
    if (!OPTIONAL_NOTIFICATION_CATEGORIES.includes(key) || typeof value !== "boolean") throw new AppError("Invalid optional notification preference", 422, [{ code: "preference_invalid", message: "Optional category and value must be valid" }]);
    updates[`optionalCategories.${key}`] = value;
  }
  for (const [key, value] of Object.entries(input?.channels || {})) {
    if (!["email", "push"].includes(key) || typeof value !== "boolean") throw new AppError("Invalid notification channel preference", 422, [{ code: "preference_invalid", message: "Only email and push channel preferences can be changed" }]);
    updates[`channels.${key}`] = value;
  }
  await NotificationPreference.updateOne({ recipient }, { $setOnInsert: { recipient }, $set: updates }, { upsert: true, setDefaultsOnInsert: true });
  await writeAuditLog(recipient, "NOTIFICATION_CONSENT_UPDATED", "NotificationPreference", recipient, { channels: Object.keys(input?.channels || {}), categories: Object.keys(input?.optionalCategories || {}) });
  return getPreferences(recipient);
};
