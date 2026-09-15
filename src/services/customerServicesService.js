import mongoose from "mongoose";
import AppError from "../utils/AppError.js";
const invalid = (message) => new AppError("Request validation failed", 400, [{ code: "validation", message }]);
import ServiceRequest, { SERVICE_REQUEST_STATUSES, SERVICE_TYPES } from "../models/ServiceRequest.js";
import ServiceQuotation from "../models/ServiceQuotation.js";
import MaintenancePlan from "../models/MaintenancePlan.js";
import ServiceHistoryEntry from "../models/ServiceHistoryEntry.js";
import Evidence from "../models/Evidence.js";
import { SERVICE_RESPONSIBILITY_POLICY } from "./customerPolicyService.js";
import { createCustomerNotification } from "./notificationService.js";
import { conflict, documentMetadata, fingerprint, idText, isObjectId, listEvidenceSummaries, pageInput, pagination, requireIdempotencyKey, unavailable } from "./customerDomainService.js";
import { writeAuditLog } from "./auditService.js";
import { capturePolicyAcceptances } from "./contentService.js";

const requestDto = async (item) => ({
  id: idText(item._id),
  serviceType: item.serviceType,
  device: {
    category: item.deviceCategory,
    brand: item.brand || null,
    model: item.model || null,
    currentSpecifications: item.currentSpecifications || null,
  },
  desiredOutcome: item.desiredOutcome,
  softwareRequirements: item.softwareRequirements || null,
  dataMigrationRequired: item.dataMigrationRequired,
  fulfilmentPreference: item.fulfilmentPreference,
  timeConstraints: item.timeConstraints || null,
  notes: item.notes || null,
  responsibilityPolicyVersion: item.responsibilityPolicyVersion,
  status: item.status,
  timeline: (item.timeline || []).map((entry) => ({ status: entry.status, at: entry.at, message: entry.message || null })),
  assessment: item.assessment?.result
    ? {
        result: item.assessment.result,
        summary: item.assessment.summary || null,
        assumptions: item.assessment.assumptions || [],
        requirements: item.assessment.requirements || [],
        requiredParts: item.assessment.requiredParts || [],
        requiredSoftware: item.assessment.requiredSoftware || [],
        limitations: item.assessment.limitations || [],
        exclusions: item.assessment.exclusions || [],
        customerResponsibilities: item.assessment.customerResponsibilities || [],
        nextAction: item.assessment.nextAction || null,
        assessedAt: item.assessment.assessedAt || null,
      }
    : null,
  evidence: await listEvidenceSummaries({ owner: item.customer, subjectType: "service_request", subject: item._id }),
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

const quoteDto = (quote) => ({
  id: idText(quote._id),
  serviceRequestId: idText(quote.serviceRequest),
  version: quote.version,
  lineItems: (quote.lineItems || []).map((line) => ({ description: line.description, amount: line.amount })),
  totalAmount: quote.totalAmount,
  currency: quote.currency,
  estimatedDays: quote.estimatedDays,
  expiresAt: quote.expiresAt,
  status: quote.status,
  superseded: Boolean(quote.superseded),
  depositRequirement: quote.depositRequirement || { required: false, amount: 0, currency: quote.currency, dueBeforeWork: false },
  paymentState: quote.paymentState || { status: "not_required", confirmedAmount: 0, remainingAmount: 0 },
  createdAt: quote.createdAt,
});

const ownedRequest = async (id, customer) => {
  if (!isObjectId(id)) throw unavailable("Service request");
  const request = await ServiceRequest.findOne({ _id: id, customer });
  if (!request) throw unavailable("Service request");
  return request;
};

export const getPolicy = () => SERVICE_RESPONSIBILITY_POLICY;

export const createServiceRequest = async ({ customer, input, idempotencyKey }) => {
  const key = requireIdempotencyKey(idempotencyKey);
  if (!SERVICE_TYPES.includes(input.serviceType)) throw invalid("Service type is invalid");
  if (typeof input.deviceCategory !== "string" || !input.deviceCategory.trim() || typeof input.desiredOutcome !== "string" || input.desiredOutcome.trim().length < 3) {
    throw invalid("Device category and desired outcome are required");
  }
  if (input.licenceOwnershipAcknowledgement !== true || input.backupAcknowledgement !== true) {
    throw invalid("Licence ownership and backup acknowledgements are required");
  }
  const notes = typeof input.notes === "string" ? input.notes.trim() : "";
  if (/\b(password|passcode|recovery key|seed phrase|card number|cvv|bank pin)\b/i.test(notes)) {
    throw invalid("Do not include passwords, recovery keys, or payment credentials in service notes");
  }
  const normalized = {
    serviceType: input.serviceType,
    deviceCategory: input.deviceCategory.trim(),
    brand: typeof input.brand === "string" ? input.brand.trim().slice(0, 120) : null,
    model: typeof input.model === "string" ? input.model.trim().slice(0, 160) : null,
    currentSpecifications: typeof input.currentSpecifications === "string" ? input.currentSpecifications.trim().slice(0, 2000) : null,
    desiredOutcome: input.desiredOutcome.trim().slice(0, 2000),
    softwareRequirements: typeof input.softwareRequirements === "string" ? input.softwareRequirements.trim().slice(0, 2000) : null,
    dataMigrationRequired: Boolean(input.dataMigrationRequired),
    licenceOwnershipAcknowledgement: true,
    backupAcknowledgement: true,
    fulfilmentPreference: ["onsite", "drop_off", "pickup", "remote_assessment"].includes(input.fulfilmentPreference) ? input.fulfilmentPreference : "drop_off",
    timeConstraints: typeof input.timeConstraints === "string" ? input.timeConstraints.trim().slice(0, 500) : null,
    notes: notes.slice(0, 3000),
    responsibilityPolicyVersion: SERVICE_RESPONSIBILITY_POLICY.version,
  };
  const hash = fingerprint(normalized);

  const existing = await ServiceRequest.findOne({ customer, idempotencyKey: key });
  if (existing) {
    if (existing.idempotencyFingerprint !== hash) throw conflict("service_idempotency_conflict", "This idempotency key is already associated with a different service request");
    return requestDto(existing);
  }

  try {
    const policyAcceptances = await capturePolicyAcceptances("service");
    const responsibilityPolicy = policyAcceptances.find((item) => item.key === "repair_custody_terms");
    const request = await ServiceRequest.create({
      customer,
      ...normalized,
      responsibilityPolicyVersion: responsibilityPolicy?.version?.toString() || normalized.responsibilityPolicyVersion,
      policyAcceptances,
      idempotencyKey: key,
      idempotencyFingerprint: hash,
      status: "ASSESSMENT_REQUIRED",
      timeline: [
        { status: "REQUESTED", at: new Date(), message: "Service request received" },
        { status: "ASSESSMENT_REQUIRED", at: new Date(), message: "An assessment is required before compatibility is confirmed." },
      ],
    });
    await writeAuditLog(customer, "CUSTOMER_SERVICE_REQUEST_CREATED", "ServiceRequest", request._id, { serviceType: request.serviceType });
    return requestDto(request);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const replay = await ServiceRequest.findOne({ customer, idempotencyKey: key });
    if (!replay || replay.idempotencyFingerprint !== hash) throw conflict("service_idempotency_conflict", "This idempotency key is already associated with a different service request");
    return requestDto(replay);
  }
};

export const listServiceRequests = async ({ customer, query }) => {
  const { page, limit, skip } = pageInput(query);
  const [items, total] = await Promise.all([
    ServiceRequest.find({ customer }).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    ServiceRequest.countDocuments({ customer }),
  ]);
  return { requests: await Promise.all(items.map(requestDto)), pagination: pagination(page, limit, total) };
};

export const getServiceRequest = async ({ customer, id }) => requestDto(await ownedRequest(id, customer));

export const listServiceQuotations = async ({ customer, requestId }) => {
  await ownedRequest(requestId, customer);
  const quotes = await ServiceQuotation.find({ serviceRequest: requestId, customer }).sort({ version: -1 });
  return quotes.map(quoteDto);
};

export const getServiceQuote = async ({ customer, id }) => {
  if (!isObjectId(id)) throw unavailable("Service quotation");
  const quote = await ServiceQuotation.findOne({ _id: id, customer });
  if (!quote) throw unavailable("Service quotation");
  return quoteDto(quote);
};

export const decideServiceQuote = async ({ customer, id, decision, version, idempotencyKey }) => {
  if (!isObjectId(id) || !Number.isSafeInteger(version) || !["approve", "decline"].includes(decision)) throw unavailable("Service quotation");
  const key = requireIdempotencyKey(idempotencyKey);
  const now = new Date();
  const target = decision === "approve" ? "APPROVED" : "DECLINED";

  const session = await mongoose.startSession();
  try {
    let quote;
    await session.withTransaction(async () => {
      const existing = await ServiceQuotation.findOne({ _id: id, customer }).session(session);
      if (!existing) throw unavailable("Service quotation");
      if (existing.decision?.type) {
        if (existing.decision.type === target && existing.decision.idempotencyKey === key) {
          quote = existing;
          return;
        }
        throw conflict("service_quote_decided", "This quotation has already been decided");
      }
      if (existing.version !== version || existing.superseded || !existing.isActionable || existing.status !== "ISSUED" || existing.expiresAt <= now) {
        if (existing.expiresAt <= now && existing.status === "ISSUED") {
          existing.status = "EXPIRED";
          existing.isActionable = false;
          await existing.save({ session });
        }
        throw conflict(existing.expiresAt <= now ? "service_quote_expired" : "service_quote_not_actionable", "This quotation is no longer actionable");
      }
      const request = await ServiceRequest.findOne({ _id: existing.serviceRequest, customer }).session(session);
      if (!request) throw unavailable("Service request");
      if (request.assessment?.result === "INCOMPATIBLE") {
        throw conflict("service_incompatible", "An incompatible assessment cannot proceed to quote approval");
      }
      existing.status = target;
      existing.isActionable = false;
      existing.decision = { type: target, at: now, idempotencyKey: key, version };
      await existing.save({ session });
      quote = existing;

      request.status = target === "APPROVED" ? "APPROVED" : "DECLINED";
      request.timeline.push({ status: request.status, at: now, message: target === "APPROVED" ? "Service quotation approved" : "Service quotation declined" });
      await request.save({ session });

      await writeAuditLog(customer, target === "APPROVED" ? "CUSTOMER_SERVICE_QUOTE_APPROVED" : "CUSTOMER_SERVICE_QUOTE_DECLINED", "ServiceQuotation", existing._id, { version }, session);
    });
    return quoteDto(quote);
  } finally {
    await session.endSession();
  }
};

export const recordAssessment = async ({ actor, requestId, assessment }) => {
  if (!isObjectId(requestId) || !["COMPATIBLE", "PARTIALLY_COMPATIBLE", "INCOMPATIBLE"].includes(assessment.result)) throw unavailable("Service request");
  const request = await ServiceRequest.findById(requestId);
  if (!request) throw unavailable("Service request");

  request.assessment = {
    result: assessment.result,
    summary: String(assessment.summary || "").slice(0, 2000),
    assumptions: Array.isArray(assessment.assumptions) ? assessment.assumptions.slice(0, 20).map(String) : [],
    requirements: Array.isArray(assessment.requirements) ? assessment.requirements.slice(0, 20).map(String) : [],
    requiredParts: Array.isArray(assessment.requiredParts) ? assessment.requiredParts.slice(0, 20).map(String) : [],
    requiredSoftware: Array.isArray(assessment.requiredSoftware) ? assessment.requiredSoftware.slice(0, 20).map(String) : [],
    limitations: Array.isArray(assessment.limitations) ? assessment.limitations.slice(0, 20).map(String) : [],
    exclusions: Array.isArray(assessment.exclusions) ? assessment.exclusions.slice(0, 20).map(String) : [],
    customerResponsibilities: Array.isArray(assessment.customerResponsibilities) ? assessment.customerResponsibilities.slice(0, 20).map(String) : [],
    nextAction: String(assessment.nextAction || "").slice(0, 500),
    assessedAt: new Date(),
  };

  request.status = assessment.result;
  request.timeline.push({ status: request.status, at: new Date(), message: "Compatibility assessment updated" });
  await request.save();

  await createCustomerNotification({
    recipient: request.customer,
    type: "service_assessment_updated",
    title: "Service assessment updated",
    safePreview: "Your service compatibility assessment has been updated.",
    resourceType: "service_request",
    resourceId: request._id,
    eventKey: `service-assessment:${request._id}:${request.updatedAt.getTime()}`,
  });

  await writeAuditLog(actor, "SERVICE_ASSESSMENT_RECORDED", "ServiceRequest", request._id, { result: assessment.result });
  return requestDto(request);
};

export const createStaffServiceQuote = async ({ actor, requestId, input }) => {
  if (!isObjectId(requestId)) throw unavailable("Service request");
  const request = await ServiceRequest.findById(requestId);
  if (!request) throw unavailable("Service request");
  if (request.assessment?.result === "INCOMPATIBLE") {
    throw conflict("service_incompatible", "An incompatible request cannot receive an actionable quote");
  }
  if (!Array.isArray(input.lineItems) || !input.lineItems.length) throw invalid("Service quote requires line items");

  const nextVersion = ((await ServiceQuotation.findOne({ serviceRequest: request._id }).sort({ version: -1 }).lean())?.version || 0) + 1;
  await ServiceQuotation.updateMany({ serviceRequest: request._id, isActionable: true }, { $set: { isActionable: false, superseded: true, status: "SUPERSEDED" } });

  const quote = await ServiceQuotation.create({
    serviceRequest: request._id,
    customer: request.customer,
    version: nextVersion,
    lineItems: input.lineItems,
    totalAmount: input.totalAmount,
    estimatedDays: input.estimatedDays,
    expiresAt: input.expiresAt,
    depositRequirement: input.depositRequirement || { required: false, amount: 0, currency: "NGN", dueBeforeWork: false },
    paymentState: input.depositRequirement?.required
      ? { status: "pending", confirmedAmount: 0, remainingAmount: input.depositRequirement.amount }
      : { status: "not_required", confirmedAmount: 0, remainingAmount: 0 },
  });

  request.status = "AWAITING_DECISION";
  request.timeline.push({ status: request.status, at: new Date(), message: "A service quotation is ready for review." });
  await request.save();

  await createCustomerNotification({
    recipient: request.customer,
    type: "service_quotation_issued",
    title: "Service quotation ready",
    safePreview: "A service quotation is ready for review.",
    resourceType: "service_quotation",
    resourceId: quote._id,
    eventKey: `service-quote:${quote._id}`,
  });

  await writeAuditLog(actor, "SERVICE_QUOTE_ISSUED", "ServiceQuotation", quote._id, { version: quote.version });
  return quoteDto(quote);
};

const planDto = (plan) => ({
  id: idText(plan._id),
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
  version: plan.version || 0,
  cancellation: plan.status === "CANCELLED" ? { at: plan.cancelledAt || null, reason: plan.cancellationReason || null } : null,
  renewedFromId: plan.renewedFrom ? idText(plan.renewedFrom) : null,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
});

export const listMaintenancePlans = async ({ customer, query }) => {
  const { page, limit, skip } = pageInput(query);
  const [items, total] = await Promise.all([
    MaintenancePlan.find({ customer }).sort({ startDate: -1 }).skip(skip).limit(limit),
    MaintenancePlan.countDocuments({ customer }),
  ]);
  return { plans: items.map(planDto), pagination: pagination(page, limit, total) };
};

export const getMaintenancePlan = async ({ customer, id }) => {
  if (!isObjectId(id)) throw unavailable("Maintenance plan");
  const plan = await MaintenancePlan.findOne({ _id: id, customer });
  if (!plan) throw unavailable("Maintenance plan");
  return planDto(plan);
};

const historyDto = async (entry) => {
  const docs = entry.authorizedDocuments?.length
    ? await Evidence.find({ _id: { $in: entry.authorizedDocuments }, owner: entry.customer }).select("_id displayName detectedMimeType createdAt").lean()
    : [];
  return {
    id: idText(entry._id),
    serviceReference: entry.serviceReference,
    serviceType: entry.serviceType,
    deviceSafeLabel: entry.deviceSafeLabel,
    performedAt: entry.performedAt,
    status: entry.status,
    workSummary: entry.workSummary,
    customerVisiblePartsAndServices: entry.customerVisiblePartsAndServices || [],
    warrantyOutcome: entry.warrantyOutcome || null,
    nextRecommendedMaintenance: entry.nextRecommendedMaintenance || null,
    authorizedDocuments: docs.map(documentMetadata),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
};

export const listServiceHistory = async ({ customer, query }) => {
  const { page, limit, skip } = pageInput(query);
  const [items, total] = await Promise.all([
    ServiceHistoryEntry.find({ customer }).sort({ performedAt: -1 }).skip(skip).limit(limit),
    ServiceHistoryEntry.countDocuments({ customer }),
  ]);
  return { history: await Promise.all(items.map(historyDto)), pagination: pagination(page, limit, total) };
};

export const getServiceHistory = async ({ customer, id }) => {
  if (!isObjectId(id)) throw unavailable("Service history");
  const entry = await ServiceHistoryEntry.findOne({ _id: id, customer });
  if (!entry) throw unavailable("Service history");
  return historyDto(entry);
};
