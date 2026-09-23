import mongoose from "mongoose";
import ContentPage from "../models/ContentPage.js";
import PolicyVersion from "../models/PolicyVersion.js";
import Evidence from "../models/Evidence.js";
import Order from "../models/Order.js";
import ProcurementRequest from "../models/ProcurementRequest.js";
import Repair from "../models/Repair.js";
import ReturnRequest from "../models/ReturnRequest.js";
import ServiceRequest from "../models/ServiceRequest.js";
import Warranty from "../models/Warranty.js";
import AppError from "../utils/AppError.js";
import { conflict, fingerprint, idText, isObjectId, requireIdempotencyKey, unavailable } from "./customerDomainService.js";
import { writeAuditLog } from "./auditService.js";

export const REQUIRED_LAUNCH_POLICY_KEYS = Object.freeze([
  "terms_of_sale",
  "warranty_policy",
  "returns_refund_policy",
  "repair_custody_terms",
  "device_data_backup_acknowledgement",
  "privacy_notice",
  "cookie_analytics_notice",
  "delivery_pickup_policy",
  "b2b_quotation_terms",
]);

export const POLICY_KEYS_BY_DOMAIN = Object.freeze({
  checkout: Object.freeze(["terms_of_sale", "delivery_pickup_policy"]),
  repair_intake: Object.freeze(["repair_custody_terms", "device_data_backup_acknowledgement", "privacy_notice"]),
  warranty: Object.freeze(["warranty_policy"]),
  return: Object.freeze(["returns_refund_policy"]),
  evidence: Object.freeze(["privacy_notice"]),
  b2b: Object.freeze(["b2b_quotation_terms"]),
  service: Object.freeze(["repair_custody_terms", "device_data_backup_acknowledgement"]),
});

const configFor = (kind) => kind === "page"
  ? { Model: ContentPage, identity: "slug", targetType: "ContentPage", unavailableName: "Content page" }
  : { Model: PolicyVersion, identity: "key", targetType: "PolicyVersion", unavailableName: "Policy version" };

const publicPageDto = (doc) => ({
  id: idText(doc._id), slug: doc.slug, locale: doc.locale, version: doc.version,
  title: doc.title, summary: doc.summary, body: doc.body,
  publishedAt: doc.publishedAt, updatedAt: doc.updatedAt,
});
const publicPolicyDto = (doc) => ({
  id: idText(doc._id), key: doc.key, locale: doc.locale, version: doc.version,
  title: doc.title, summary: doc.summary, body: doc.body, effectiveAt: doc.effectiveAt,
  publishedAt: doc.publishedAt, updatedAt: doc.updatedAt,
});
const publicDto = (kind, doc) => kind === "page" ? publicPageDto(doc) : publicPolicyDto(doc);
const adminDto = (kind, doc) => ({
  ...publicDto(kind, doc),
  status: doc.status,
  stateVersion: doc.stateVersion,
  submittedAt: doc.submittedAt || null,
  reviewedAt: doc.reviewedAt || null,
  supersededAt: doc.supersededAt || null,
  archivedAt: doc.archivedAt || null,
  createdAt: doc.createdAt,
});

const normalizedDraft = (kind, input) => ({
  [kind === "page" ? "slug" : "key"]: input[kind === "page" ? "slug" : "key"].trim().toLowerCase(),
  locale: input.locale || "en-NG",
  title: input.title.trim(),
  summary: input.summary.trim(),
  body: input.body,
  ...(kind === "policy" ? { effectiveAt: new Date(input.effectiveAt) } : {}),
});

export const createDraft = async ({ kind, actor, input, idempotencyKey }) => {
  const { Model, identity, targetType } = configFor(kind);
  const key = requireIdempotencyKey(idempotencyKey);
  const normalized = normalizedDraft(kind, input);
  const requestHash = fingerprint(normalized);
  const existing = await Model.findOne({ createdBy: actor, idempotencyKey: key }).select("+idempotencyFingerprint");
  if (existing) {
    if (existing.idempotencyFingerprint !== requestHash) throw conflict("content_idempotency_conflict", "This idempotency key is associated with different content");
    return { created: false, document: adminDto(kind, existing) };
  }
  const session = await mongoose.startSession();
  let document;
  try {
    await session.withTransaction(async () => {
      const latest = await Model.findOne({ [identity]: { $eq: normalized[identity] }, locale: { $eq: normalized.locale } }).sort({ version: -1 }).select("version").session(session);
      [document] = await Model.create([{ ...normalized, version: (latest?.version || 0) + 1, createdBy: actor, idempotencyKey: key, idempotencyFingerprint: requestHash }], { session });
      await writeAuditLog(actor, kind === "page" ? "CONTENT_DRAFT_CREATED" : "POLICY_DRAFT_CREATED", targetType, document._id, { version: document.version, identity: normalized[identity] }, session);
    });
    return { created: true, document: adminDto(kind, document) };
  } catch (error) {
    if (error?.code === 11000) {
      const replay = await Model.findOne({ createdBy: actor, idempotencyKey: key }).select("+idempotencyFingerprint");
      if (replay?.idempotencyFingerprint === requestHash) return { created: false, document: adminDto(kind, replay) };
      throw conflict("content_version_conflict", "Another draft version was created concurrently");
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const actionRules = Object.freeze({
  submit: { from: "DRAFT", to: "IN_REVIEW", time: "submittedAt" },
  approve: { from: "IN_REVIEW", to: "APPROVED", time: "reviewedAt" },
  publish: { from: "APPROVED", to: "PUBLISHED", time: "publishedAt" },
  archive: { from: ["DRAFT", "IN_REVIEW", "APPROVED", "SUPERSEDED"], to: "ARCHIVED", time: "archivedAt" },
});
const auditAction = Object.freeze({
  page: Object.freeze({ submit: "CONTENT_SUBMITTED", approve: "CONTENT_APPROVED", publish: "CONTENT_PUBLISHED", archive: "CONTENT_ARCHIVED" }),
  policy: Object.freeze({ submit: "POLICY_SUBMITTED", approve: "POLICY_APPROVED", publish: "POLICY_PUBLISHED", archive: "POLICY_ARCHIVED" }),
});

export const transition = async ({ kind, action, actor, id, expectedStateVersion }) => {
  if (!isObjectId(id)) throw unavailable(configFor(kind).unavailableName);
  const rule = actionRules[action];
  if (!rule) throw new AppError("Unsupported content transition", 400);
  const { Model, identity, targetType, unavailableName } = configFor(kind);
  const session = await mongoose.startSession();
  let document;
  try {
    await session.withTransaction(async () => {
      document = await Model.findById(id).select("+createdBy +reviewedBy +publishedBy").session(session);
      if (!document) throw unavailable(unavailableName);
      if (document.stateVersion !== expectedStateVersion) throw conflict("content_state_version_conflict", "The content version changed");
      const allowed = Array.isArray(rule.from) ? rule.from : [rule.from];
      if (!allowed.includes(document.status)) throw conflict("content_transition_invalid", `Cannot ${action} content in its current state`);
      if (action === "approve" && idText(document.createdBy) === idText(actor)) {
        throw new AppError("Content approval requires a different authorized reviewer", 403, [{ code: "content_separation_of_duties", message: "The draft creator cannot approve the same version" }]);
      }
      const now = new Date();
      if (action === "publish") {
        await Model.updateMany({ [identity]: document[identity], locale: document.locale, status: "PUBLISHED", _id: { $ne: document._id } }, { $set: { status: "SUPERSEDED", supersededAt: now }, $inc: { stateVersion: 1 } }, { session });
        document.publishedBy = actor;
      }
      if (action === "approve") document.reviewedBy = actor;
      document.status = rule.to;
      document[rule.time] = now;
      document.stateVersion += 1;
      await document.save({ session });
      await writeAuditLog(actor, auditAction[kind][action], targetType, document._id, { version: document.version, identity: document[identity] }, session);
    });
    return adminDto(kind, document);
  } finally {
    await session.endSession();
  }
};

export const preview = async (kind, id) => {
  if (!isObjectId(id)) throw unavailable(configFor(kind).unavailableName);
  const doc = await configFor(kind).Model.findById(id);
  if (!doc) throw unavailable(configFor(kind).unavailableName);
  return adminDto(kind, doc);
};

export const publicDocument = async (kind, identityValue) => {
  const { Model, identity, unavailableName } = configFor(kind);
  const doc = await Model.findOne({ [identity]: identityValue, locale: "en-NG", status: "PUBLISHED" });
  if (!doc) throw unavailable(unavailableName);
  return publicDto(kind, doc);
};

export const capturePolicyAcceptances = async (domain, { session = null, acceptedAt = new Date() } = {}) => {
  const keys = POLICY_KEYS_BY_DOMAIN[domain];
  if (!keys) throw new AppError("Unknown policy acceptance domain", 500);
  const query = PolicyVersion.find({ key: { $in: keys }, locale: "en-NG", status: "PUBLISHED" }).select("_id key version").sort({ key: 1 });
  if (session) query.session(session);
  const policies = await query.lean();
  return policies.map((policy) => ({ policyVersionId: policy._id, key: policy.key, version: policy.version, acceptedAt }));
};

const referenceModels = [Order, Repair, Warranty, ReturnRequest, Evidence, ProcurementRequest, ServiceRequest];
export const deletePolicyVersion = async ({ actor, id }) => {
  if (!isObjectId(id)) throw unavailable("Policy version");
  const policy = await PolicyVersion.findById(id);
  if (!policy) throw unavailable("Policy version");
  if (policy.status === "PUBLISHED") throw conflict("policy_version_current", "The current published policy cannot be deleted");
  const referenced = await Promise.any(referenceModels.map(async (Model) => {
    if (await Model.exists({ "policyAcceptances.policyVersionId": policy._id })) return true;
    throw new Error("not referenced");
  })).catch(() => false);
  if (referenced) throw conflict("policy_version_referenced", "A referenced policy version cannot be deleted");
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await PolicyVersion.deleteOne({ _id: policy._id }, { session });
      await writeAuditLog(actor, "POLICY_DELETED", "PolicyVersion", policy._id, { version: policy.version, identity: policy.key }, session);
    });
  } finally {
    await session.endSession();
  }
};
