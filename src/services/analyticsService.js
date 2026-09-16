import { createHmac } from "node:crypto";
import AnalyticsEvent from "../models/AnalyticsEvent.js";
import AppError from "../utils/AppError.js";
import { conflict, fingerprint, requireIdempotencyKey } from "./customerDomainService.js";
import { env } from "../config/env.js";

const CLIENT_EVENTS = Object.freeze({ product_viewed: ["surface", "catalogueRef"], guidance_started: ["surface"], guidance_completed: ["outcome"], add_to_cart: ["surface"], checkout_started: ["surface"], deep_link_opened: ["target"], push_opened: ["target"] });
const TRUSTED_EVENTS = Object.freeze({ payment_succeeded: ["amountBucket", "channel"], repair_requested: ["channel"], quote_approved: ["channel"], order_completed: ["amountBucket", "channel"], support_ticket_created: ["category"], inventory_discrepancy: ["category"], guidance_completed: ["outcome"], service_completed: ["channel"] });
const forbidden = /token|secret|password|credential|serial|device|note|message|payment|card|email|phone|name|address|ip/i;
const pseudonym = (value) => createHmac("sha256", env.securityAuditHmacSecret).update(String(value)).digest("hex");
const validateProperties = (event, properties, catalog) => {
  const allowed = catalog[event];
  if (!allowed) throw new AppError("Analytics event is not supported", 422, [{ code: "analytics_event_invalid", message: "Event name is not allowlisted" }]);
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw new AppError("Analytics properties are invalid", 422, [{ code: "analytics_properties_invalid", message: "Properties must be a small object" }]);
  for (const [key, value] of Object.entries(properties)) {
    if (!allowed.includes(key) || forbidden.test(key) || typeof value !== "string" || value.length > 80) throw new AppError("Analytics properties are invalid", 422, [{ code: "analytics_properties_invalid", message: "Properties must use the allowlisted safe schema" }]);
  }
  return Object.fromEntries(Object.entries(properties).filter(([key]) => allowed.includes(key)));
};
const expiry = () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
const safeDto = (item) => ({ accepted: true, id: item._id.toString(), occurredAt: item.occurredAt });
export const ingestAnalyticsEvent = async ({ subject, input, idempotencyKey }) => {
  if (input.consent === false) return { accepted: false };
  const properties = validateProperties(input.event, input.properties || {}, CLIENT_EVENTS);
  if (typeof input.anonymousId !== "string" || input.anonymousId.length < 8 || input.anonymousId.length > 256) throw new AppError("Analytics identity is invalid", 422, [{ code: "analytics_identity_invalid", message: "A bounded anonymous identifier is required" }]);
  const subjectKey = subject ? pseudonym(subject) : undefined; const key = idempotencyKey ? requireIdempotencyKey(idempotencyKey) : undefined;
  const data = { event: input.event, properties, source: "client", subjectKey, anonymousKey: pseudonym(input.anonymousId), idempotencyKey: key, idempotencyFingerprint: key ? fingerprint({ event: input.event, properties, anonymousId: input.anonymousId }) : undefined, occurredAt: new Date(), expiresAt: expiry() };
  if (key && subjectKey) { const replay = await AnalyticsEvent.findOne({ subjectKey, idempotencyKey: key }).select("+idempotencyFingerprint"); if (replay) { if (replay.idempotencyFingerprint !== data.idempotencyFingerprint) throw conflict("analytics_idempotency_conflict", "This idempotency key is associated with different analytics data"); return safeDto(replay); } }
  try { return safeDto(await AnalyticsEvent.create(data)); } catch (error) { if (error?.code !== 11000) throw error; const replay = await AnalyticsEvent.findOne({ subjectKey, idempotencyKey: key }).select("+idempotencyFingerprint"); if (replay?.idempotencyFingerprint === data.idempotencyFingerprint) return safeDto(replay); throw conflict("analytics_idempotency_conflict", "This idempotency key is associated with different analytics data"); }
};
export const recordTrustedAnalyticsEvent = async ({ event, properties = {} }) => AnalyticsEvent.create({ event, properties: validateProperties(event, properties, TRUSTED_EVENTS), source: "trusted_server", occurredAt: new Date(), expiresAt: expiry() });
export const kpiReport = async ({ from, to } = {}) => {
  const start = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); const end = to ? new Date(to) : new Date();
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start > end) throw new AppError("Analytics window is invalid", 422, [{ code: "analytics_window_invalid", message: "Use a valid chronological report window" }]);
  const rows = await AnalyticsEvent.aggregate([{ $match: { occurredAt: { $gte: start, $lte: end } } }, { $group: { _id: "$event", count: { $sum: 1 } } }]);
  return { window: { from: start, to: end }, generatedAt: new Date(), eventCounts: Object.fromEntries(rows.map((row) => [row._id, row.count])) };
};
