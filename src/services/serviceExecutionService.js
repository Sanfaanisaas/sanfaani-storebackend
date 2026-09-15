import mongoose from "mongoose";
import ServiceExecution from "../models/ServiceExecution.js";
import ServiceHistoryEntry from "../models/ServiceHistoryEntry.js";
import ServiceQuotation from "../models/ServiceQuotation.js";
import ServiceRequest from "../models/ServiceRequest.js";
import User from "../models/User.js";
import { USER_ROLES } from "../utils/constants.js";
import { conflict, fingerprint, idText, isObjectId, requireIdempotencyKey, unavailable } from "./customerDomainService.js";
import { createCustomerNotification } from "./notificationService.js";
import { writeAuditLog } from "./auditService.js";

const OPERATIONS_ROLES = new Set([USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN]);

const executionDto = (execution) => ({
  id: idText(execution._id),
  serviceRequestId: idText(execution.serviceRequest),
  customer: idText(execution.customer),
  quotation: {
    id: idText(execution.quotation.id),
    version: execution.quotation.version,
    totalAmount: execution.quotation.totalAmount,
    currency: execution.quotation.currency,
    estimatedDays: execution.quotation.estimatedDays,
  },
  assignedTechnicianId: idText(execution.assignedTechnician),
  schedule: {
    startAt: execution.schedule.startAt,
    endAt: execution.schedule.endAt,
    mode: execution.schedule.mode,
    location: execution.schedule.location || null,
  },
  deviceSafeLabel: execution.deviceSafeLabel,
  status: execution.status,
  version: execution.version,
  timestamps: {
    scheduledAt: execution.actions?.schedule?.at || execution.createdAt,
    startedAt: execution.startedAt || null,
    completedAt: execution.completedAt || null,
    cancelledAt: execution.cancelledAt || null,
    updatedAt: execution.updatedAt,
  },
});

const actorRecord = async (actor, session) => {
  const principal = await User.findById(actor).select("role").session(session || null);
  if (!principal) throw unavailable("Service execution");
  return principal;
};

const requireOperationsActor = async (actor, session) => {
  const principal = await actorRecord(actor, session);
  if (!OPERATIONS_ROLES.has(principal.role)) throw unavailable("Service execution");
  return principal;
};

const requireExecutionActor = async ({ actor, execution, session, operationsOnly = false }) => {
  const principal = await actorRecord(actor, session);
  if (OPERATIONS_ROLES.has(principal.role)) return principal;
  if (!operationsOnly && principal.role === USER_ROLES.TECHNICIAN && idText(execution.assignedTechnician) === idText(actor)) return principal;
  throw unavailable("Service execution");
};

const actionSelection = "+actions.schedule.idempotencyKey +actions.schedule.fingerprint +actions.start.idempotencyKey +actions.start.fingerprint +actions.complete.idempotencyKey +actions.complete.fingerprint +actions.cancel.idempotencyKey +actions.cancel.fingerprint";

const normalizeSchedule = (input) => ({
  expectedVersion: input.expectedVersion,
  assignedTechnicianId: idText(input.assignedTechnicianId),
  scheduledStartAt: new Date(input.scheduledStartAt).toISOString(),
  scheduledEndAt: new Date(input.scheduledEndAt).toISOString(),
  mode: input.mode,
  location: input.location || null,
  deviceSafeLabel: input.deviceSafeLabel,
  internalNotes: input.internalNotes || null,
});

export const scheduleService = async ({ actor, requestId, input, idempotencyKey }) => {
  if (!isObjectId(requestId)) throw unavailable("Service request");
  const idempotency = requireIdempotencyKey(idempotencyKey);
  const normalized = normalizeSchedule(input);
  const hash = fingerprint(normalized);
  const session = await mongoose.startSession();
  let result;
  let created = false;
  try {
    await session.withTransaction(async () => {
      await requireOperationsActor(actor, session);
      const replay = await ServiceExecution.findOne({ serviceRequest: requestId }).select(actionSelection).session(session);
      if (replay) {
        if (replay.actions?.schedule?.idempotencyKey === idempotency && replay.actions.schedule.fingerprint === hash) {
          result = replay;
          return;
        }
        if (replay.actions?.schedule?.idempotencyKey === idempotency) throw conflict("service_schedule_idempotency_conflict", "This idempotency key is associated with different scheduling details");
        throw conflict("service_already_scheduled", "This service request already has an execution schedule");
      }

      const serviceRequest = await ServiceRequest.findById(requestId).session(session);
      if (!serviceRequest) throw unavailable("Service request");
      if (serviceRequest.__v !== normalized.expectedVersion) throw conflict("service_request_version_conflict", "The service request has changed");
      if (serviceRequest.status !== "APPROVED" || serviceRequest.assessment?.result === "INCOMPATIBLE") throw conflict("service_request_not_executable", "The service request is not approved for execution");

      const quotation = await ServiceQuotation.findOne({ serviceRequest: serviceRequest._id }).sort({ version: -1, _id: -1 }).session(session);
      if (!quotation || quotation.status !== "APPROVED" || quotation.superseded || quotation.decision?.type !== "APPROVED" || quotation.expiresAt <= new Date()) {
        throw conflict("service_quote_not_executable", "The latest service quotation is not executable");
      }
      if (quotation.depositRequirement?.required && quotation.depositRequirement?.dueBeforeWork) {
        const confirmed = quotation.paymentState?.status === "confirmed" && quotation.paymentState.confirmedAmount >= quotation.depositRequirement.amount;
        if (!confirmed) throw conflict("service_deposit_required", "The required deposit must be confirmed before work is scheduled");
      }

      const technician = await User.findOne({ _id: normalized.assignedTechnicianId, role: USER_ROLES.TECHNICIAN }).session(session);
      if (!technician) throw conflict("service_technician_invalid", "Assign an active technician account");

      const now = new Date();
      [result] = await ServiceExecution.create([{
        serviceRequest: serviceRequest._id,
        customer: serviceRequest.customer,
        quotation: { id: quotation._id, version: quotation.version, totalAmount: quotation.totalAmount, currency: quotation.currency, estimatedDays: quotation.estimatedDays },
        assignedTechnician: technician._id,
        schedule: { startAt: normalized.scheduledStartAt, endAt: normalized.scheduledEndAt, mode: normalized.mode, location: normalized.location },
        deviceSafeLabel: normalized.deviceSafeLabel,
        internalNotes: normalized.internalNotes,
        status: "SCHEDULED",
        version: 1,
        actions: { schedule: { idempotencyKey: idempotency, fingerprint: hash, at: now, actor } },
      }], { session });
      serviceRequest.status = "SCHEDULED";
      serviceRequest.timeline.push({ status: "SCHEDULED", at: now, message: "Service work has been scheduled." });
      await serviceRequest.save({ session });
      await writeAuditLog(actor, "SERVICE_EXECUTION_SCHEDULED", "ServiceExecution", result._id, { quotationVersion: quotation.version }, session);
      await createCustomerNotification({ recipient: serviceRequest.customer, type: "service_scheduled", title: "Service scheduled", safePreview: "Your approved service has been scheduled.", resourceType: "service_request", resourceId: serviceRequest._id, eventKey: `service-scheduled:${result._id}`, session });
      created = true;
    });
    return { execution: executionDto(result), created };
  } finally {
    await session.endSession();
  }
};

const transitionExecution = async ({ actor, executionId, expectedStatus, nextStatus, expectedVersion, idempotencyKey, action, reason }) => {
  if (!isObjectId(executionId)) throw unavailable("Service execution");
  const idempotency = requireIdempotencyKey(idempotencyKey);
  const hash = fingerprint({ expectedVersion, reason: reason || null });
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const execution = await ServiceExecution.findById(executionId).select(actionSelection).session(session);
      if (!execution) throw unavailable("Service execution");
      await requireExecutionActor({ actor, execution, session, operationsOnly: action === "cancel" });
      const recorded = execution.actions?.[action];
      if (recorded?.idempotencyKey) {
        if (recorded.idempotencyKey === idempotency && recorded.fingerprint === hash) {
          result = execution;
          return;
        }
        throw conflict(`service_${action}_idempotency_conflict`, `This service ${action} request conflicts with an earlier request`);
      }
      if (execution.version !== expectedVersion) throw conflict("service_execution_version_conflict", "The service execution has changed");
      const allowedCurrent = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
      if (!allowedCurrent.includes(execution.status)) throw conflict("service_execution_transition_invalid", `Service execution cannot transition from ${execution.status} to ${nextStatus}`);
      const now = new Date();
      execution.status = nextStatus;
      execution.version += 1;
      execution.actions[action] = { idempotencyKey: idempotency, fingerprint: hash, at: now, actor };
      if (action === "start") execution.startedAt = now;
      if (action === "cancel") {
        execution.cancelledAt = now;
        execution.cancellationReason = reason;
      }
      await execution.save({ session });
      const serviceRequest = await ServiceRequest.findById(execution.serviceRequest).session(session);
      if (!serviceRequest) throw unavailable("Service request");
      serviceRequest.status = nextStatus;
      serviceRequest.timeline.push({ status: nextStatus, at: now, message: action === "start" ? "Service work has started." : "Service work was cancelled." });
      await serviceRequest.save({ session });
      await writeAuditLog(actor, action === "start" ? "SERVICE_EXECUTION_STARTED" : "SERVICE_EXECUTION_CANCELLED", "ServiceExecution", execution._id, action === "cancel" ? { reason } : {}, session);
      await createCustomerNotification({ recipient: execution.customer, type: `service_${action === "start" ? "started" : "cancelled"}`, title: action === "start" ? "Service work started" : "Service cancelled", safePreview: action === "start" ? "Work on your approved service has started." : "Your service execution has been cancelled.", resourceType: "service_request", resourceId: execution.serviceRequest, eventKey: `service-${action}:${execution._id}`, session });
      result = execution;
    });
    return executionDto(result);
  } finally {
    await session.endSession();
  }
};

export const startService = (args) => transitionExecution({ ...args, expectedStatus: "SCHEDULED", nextStatus: "IN_PROGRESS", action: "start" });
export const cancelService = (args) => transitionExecution({ ...args, expectedStatus: ["SCHEDULED", "IN_PROGRESS"], nextStatus: "CANCELLED", action: "cancel" });

export const completeService = async ({ actor, executionId, input, idempotencyKey }) => {
  if (!isObjectId(executionId)) throw unavailable("Service execution");
  const idempotency = requireIdempotencyKey(idempotencyKey);
  const normalized = {
    expectedVersion: input.expectedVersion,
    workSummary: input.workSummary,
    customerVisiblePartsAndServices: input.customerVisiblePartsAndServices || [],
    warrantyOutcome: input.warrantyOutcome || null,
    nextRecommendedMaintenance: input.nextRecommendedMaintenance || null,
    internalNotes: input.internalNotes || null,
  };
  const hash = fingerprint(normalized);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const execution = await ServiceExecution.findById(executionId).select(`${actionSelection} +completion.internalNotes`).session(session);
      if (!execution) throw unavailable("Service execution");
      await requireExecutionActor({ actor, execution, session });
      if (execution.actions?.complete?.idempotencyKey) {
        if (execution.actions.complete.idempotencyKey === idempotency && execution.actions.complete.fingerprint === hash) {
          result = execution;
          return;
        }
        throw conflict("service_complete_idempotency_conflict", "This service completion request conflicts with an earlier request");
      }
      if (execution.version !== normalized.expectedVersion) throw conflict("service_execution_version_conflict", "The service execution has changed");
      if (execution.status !== "IN_PROGRESS") throw conflict("service_execution_transition_invalid", "Only work in progress can be completed");
      const serviceRequest = await ServiceRequest.findById(execution.serviceRequest).session(session);
      if (!serviceRequest) throw unavailable("Service request");
      const now = new Date();
      [result] = [execution];
      execution.status = "COMPLETED";
      execution.version += 1;
      execution.completedAt = now;
      execution.completion = { workSummary: normalized.workSummary, customerVisiblePartsAndServices: normalized.customerVisiblePartsAndServices, warrantyOutcome: normalized.warrantyOutcome, nextRecommendedMaintenance: normalized.nextRecommendedMaintenance, internalNotes: normalized.internalNotes };
      execution.actions.complete = { idempotencyKey: idempotency, fingerprint: hash, at: now, actor };
      await execution.save({ session });
      serviceRequest.status = "COMPLETED";
      serviceRequest.timeline.push({ status: "COMPLETED", at: now, message: "Service work is complete." });
      await serviceRequest.save({ session });
      await ServiceHistoryEntry.create([{
        customer: execution.customer,
        serviceRequest: serviceRequest._id,
        serviceExecution: execution._id,
        serviceReference: `SRV-${idText(serviceRequest._id)}`,
        serviceType: serviceRequest.serviceType,
        deviceSafeLabel: execution.deviceSafeLabel,
        performedAt: now,
        status: "COMPLETED",
        workSummary: normalized.workSummary,
        customerVisiblePartsAndServices: normalized.customerVisiblePartsAndServices,
        warrantyOutcome: normalized.warrantyOutcome,
        nextRecommendedMaintenance: normalized.nextRecommendedMaintenance,
      }], { session });
      await createCustomerNotification({ recipient: execution.customer, type: "service_completed", title: "Service complete", safePreview: "Your service work is complete. View your service history for details.", resourceType: "service_request", resourceId: serviceRequest._id, eventKey: `service-completed:${execution._id}`, session });
      await writeAuditLog(actor, "SERVICE_EXECUTION_COMPLETED", "ServiceExecution", execution._id, { serviceRequestId: idText(serviceRequest._id) }, session);
    });
    return executionDto(result);
  } finally {
    await session.endSession();
  }
};
