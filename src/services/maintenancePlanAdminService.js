import mongoose from "mongoose";
import MaintenancePlan from "../models/MaintenancePlan.js";
import User from "../models/User.js";
import { USER_ROLES } from "../utils/constants.js";
import { conflict, fingerprint, idText, isObjectId, pageInput, pagination, requireIdempotencyKey, unavailable } from "./customerDomainService.js";
import { createCustomerNotification } from "./notificationService.js";
import { writeAuditLog } from "./auditService.js";

const STAFF = [USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN];
const privateSelection = "+idempotencyKey +idempotencyFingerprint +cancellation.idempotencyKey +cancellation.fingerprint +renewal.idempotencyKey +renewal.fingerprint +renewal.successor";

const dto = (plan) => ({
  id: idText(plan._id),
  customerId: idText(plan.customer),
  scope: plan.scope,
  coveredDevices: plan.coveredDevices || [],
  includedServices: plan.includedServices || [],
  frequency: plan.frequency,
  startDate: plan.startDate,
  renewalDate: plan.renewalDate || null,
  renewalModel: plan.renewalModel,
  visitLimits: plan.visitLimits || null,
  exclusions: plan.exclusions || [],
  status: plan.status,
  price: plan.price,
  currency: plan.currency,
  termsVersion: plan.termsVersion,
  cancellationInstructions: plan.cancellationInstructions,
  cancellation: plan.status === "CANCELLED" ? { at: plan.cancelledAt, reason: plan.cancellationReason } : null,
  renewedFromId: plan.renewedFrom ? idText(plan.renewedFrom) : null,
  version: plan.version,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
});

const requireStaff = async (actor, session) => {
  const user = await User.findOne({ _id: actor, role: { $in: STAFF } }).session(session || null);
  if (!user) throw unavailable("Maintenance plan");
};

const normalizedCreate = (input) => ({
  customerId: idText(input.customerId), scope: input.scope, coveredDevices: input.coveredDevices || [], includedServices: input.includedServices || [], frequency: input.frequency,
  startDate: new Date(input.startDate).toISOString(), renewalDate: input.renewalDate ? new Date(input.renewalDate).toISOString() : null, renewalModel: input.renewalModel,
  visitLimits: input.visitLimits || null, exclusions: input.exclusions || [], price: input.price, currency: input.currency || "NGN", termsVersion: input.termsVersion, cancellationInstructions: input.cancellationInstructions,
});

export const createPlan = async ({ actor, input, idempotencyKey }) => {
  const idempotency = requireIdempotencyKey(idempotencyKey);
  const normalized = normalizedCreate(input);
  const hash = fingerprint(normalized);
  const session = await mongoose.startSession();
  let result;
  let created = false;
  try {
    await session.withTransaction(async () => {
      await requireStaff(actor, session);
      const replay = await MaintenancePlan.findOne({ createdBy: actor, idempotencyKey: idempotency }).select(privateSelection).session(session);
      if (replay) {
        if (replay.idempotencyFingerprint !== hash) throw conflict("maintenance_plan_idempotency_conflict", "This idempotency key is associated with different plan details");
        result = replay;
        return;
      }
      const customer = await User.findOne({ _id: normalized.customerId, role: USER_ROLES.CUSTOMER }).session(session);
      if (!customer) throw unavailable("Customer");
      const now = new Date();
      [result] = await MaintenancePlan.create([{
        customer: customer._id, scope: normalized.scope, coveredDevices: normalized.coveredDevices, includedServices: normalized.includedServices,
        frequency: normalized.frequency, startDate: normalized.startDate, renewalDate: normalized.renewalDate, renewalModel: normalized.renewalModel,
        visitLimits: normalized.visitLimits, exclusions: normalized.exclusions, status: new Date(normalized.startDate) <= now ? "ACTIVE" : "UPCOMING",
        price: normalized.price, currency: normalized.currency, termsVersion: normalized.termsVersion, cancellationInstructions: normalized.cancellationInstructions,
        createdBy: actor, idempotencyKey: idempotency, idempotencyFingerprint: hash,
      }], { session });
      await writeAuditLog(actor, "MAINTENANCE_PLAN_CREATED", "MaintenancePlan", result._id, { customerId: idText(customer._id), status: result.status }, session);
      await createCustomerNotification({ recipient: customer._id, type: "maintenance_plan_created", title: "Maintenance plan created", safePreview: "Your maintenance plan is now available.", resourceType: "maintenance_plan", resourceId: result._id, eventKey: `maintenance-plan-created:${result._id}`, session });
      created = true;
    });
    return { plan: dto(result), created };
  } finally {
    await session.endSession();
  }
};

export const listPlansForStaff = async ({ actor, query }) => {
  await requireStaff(actor);
  const { page, limit, skip } = pageInput(query);
  const filter = {};
  if (query.customerId && isObjectId(query.customerId)) filter.customer = { $eq: query.customerId };
  if (query.status && ["ACTIVE", "UPCOMING", "EXPIRED", "CANCELLED"].includes(query.status)) filter.status = { $eq: query.status };
  const [items, total] = await Promise.all([MaintenancePlan.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit), MaintenancePlan.countDocuments(filter)]);
  return { plans: items.map(dto), pagination: pagination(page, limit, total) };
};

export const updatePlan = async ({ actor, planId, input }) => {
  if (!isObjectId(planId)) throw unavailable("Maintenance plan");
  const allowed = ["scope", "coveredDevices", "includedServices", "frequency", "renewalDate", "visitLimits", "exclusions", "cancellationInstructions"];
  const $set = Object.fromEntries(allowed.filter((field) => Object.prototype.hasOwnProperty.call(input, field)).map((field) => [field, input[field]]));
  if (!Object.keys($set).length) throw conflict("maintenance_plan_update_empty", "Provide at least one editable plan field");
  const session = await mongoose.startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      await requireStaff(actor, session);
      updated = await MaintenancePlan.findOneAndUpdate({ _id: { $eq: planId }, version: input.expectedVersion, status: { $in: ["ACTIVE", "UPCOMING"] } }, { $set, $inc: { version: 1 } }, { returnDocument: "after", runValidators: true, session });
      if (!updated) throw conflict("maintenance_plan_version_conflict", "The maintenance plan changed or is no longer editable");
      await writeAuditLog(actor, "MAINTENANCE_PLAN_UPDATED", "MaintenancePlan", updated._id, { version: updated.version }, session);
    });
    return dto(updated);
  } finally {
    await session.endSession();
  }
};

export const cancelPlan = async ({ actor, planId, input, idempotencyKey }) => {
  if (!isObjectId(planId)) throw unavailable("Maintenance plan");
  const idempotency = requireIdempotencyKey(idempotencyKey);
  const hash = fingerprint({ expectedVersion: input.expectedVersion, reason: input.reason });
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      await requireStaff(actor, session);
      const plan = await MaintenancePlan.findOne({ _id: { $eq: planId } }).select(privateSelection).session(session);
      if (!plan) throw unavailable("Maintenance plan");
      if (plan.cancellation?.idempotencyKey) {
        if (plan.cancellation.idempotencyKey === idempotency && plan.cancellation.fingerprint === hash) { result = plan; return; }
        throw conflict("maintenance_plan_cancel_idempotency_conflict", "This cancellation request conflicts with an earlier request");
      }
      if (plan.version !== input.expectedVersion) throw conflict("maintenance_plan_version_conflict", "The maintenance plan has changed");
      if (!["ACTIVE", "UPCOMING"].includes(plan.status)) throw conflict("maintenance_plan_transition_invalid", "This maintenance plan cannot be cancelled");
      plan.status = "CANCELLED";
      plan.cancelledAt = new Date();
      plan.cancellationReason = input.reason;
      plan.cancellation = { idempotencyKey: idempotency, fingerprint: hash };
      plan.version += 1;
      await plan.save({ session });
      await writeAuditLog(actor, "MAINTENANCE_PLAN_CANCELLED", "MaintenancePlan", plan._id, { reason: input.reason }, session);
      await createCustomerNotification({ recipient: plan.customer, type: "maintenance_plan_cancelled", title: "Maintenance plan cancelled", safePreview: "Your maintenance plan has been cancelled.", resourceType: "maintenance_plan", resourceId: plan._id, eventKey: `maintenance-plan-cancelled:${plan._id}`, session });
      result = plan;
    });
    return dto(result);
  } finally {
    await session.endSession();
  }
};

export const renewPlan = async ({ actor, planId, input, idempotencyKey }) => {
  if (!isObjectId(planId)) throw unavailable("Maintenance plan");
  const idempotency = requireIdempotencyKey(idempotencyKey);
  const normalized = { expectedVersion: input.expectedVersion, startDate: new Date(input.startDate).toISOString(), renewalDate: input.renewalDate ? new Date(input.renewalDate).toISOString() : null, price: input.price, termsVersion: input.termsVersion };
  const hash = fingerprint(normalized);
  const session = await mongoose.startSession();
  let successor;
  let created = false;
  try {
    await session.withTransaction(async () => {
      await requireStaff(actor, session);
      const plan = await MaintenancePlan.findOne({ _id: { $eq: planId } }).select(privateSelection).session(session);
      if (!plan) throw unavailable("Maintenance plan");
      if (plan.renewal?.idempotencyKey) {
        if (plan.renewal.idempotencyKey === idempotency && plan.renewal.fingerprint === hash) {
          successor = await MaintenancePlan.findById(plan.renewal.successor).session(session);
          if (successor) return;
        }
        throw conflict("maintenance_plan_renew_idempotency_conflict", "This renewal request conflicts with an earlier request");
      }
      if (plan.version !== input.expectedVersion) throw conflict("maintenance_plan_version_conflict", "The maintenance plan has changed");
      if (plan.renewalModel !== "manual_renewal" || !["ACTIVE", "EXPIRED"].includes(plan.status)) throw conflict("maintenance_plan_transition_invalid", "This maintenance plan cannot be renewed");
      const now = new Date();
      [successor] = await MaintenancePlan.create([{
        customer: plan.customer, scope: plan.scope, coveredDevices: plan.coveredDevices, includedServices: plan.includedServices, frequency: plan.frequency,
        startDate: normalized.startDate, renewalDate: normalized.renewalDate, renewalModel: plan.renewalModel, visitLimits: plan.visitLimits, exclusions: plan.exclusions,
        status: new Date(normalized.startDate) <= now ? "ACTIVE" : "UPCOMING", price: normalized.price, currency: plan.currency,
        termsVersion: normalized.termsVersion, cancellationInstructions: plan.cancellationInstructions, createdBy: actor, renewedFrom: plan._id,
      }], { session });
      plan.status = "EXPIRED";
      plan.renewal = { idempotencyKey: idempotency, fingerprint: hash, successor: successor._id };
      plan.version += 1;
      await plan.save({ session });
      await writeAuditLog(actor, "MAINTENANCE_PLAN_RENEWED", "MaintenancePlan", successor._id, { renewedFromId: idText(plan._id) }, session);
      await createCustomerNotification({ recipient: plan.customer, type: "maintenance_plan_renewed", title: "Maintenance plan renewed", safePreview: "Your next maintenance-plan term is now available.", resourceType: "maintenance_plan", resourceId: successor._id, eventKey: `maintenance-plan-renewed:${successor._id}`, session });
      created = true;
    });
    return { plan: dto(successor), created };
  } finally {
    await session.endSession();
  }
};
