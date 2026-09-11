import mongoose from "mongoose";
import AppError from "../utils/AppError.js";
const invalid = (message) => new AppError("Request validation failed", 400, [{ code: "validation", message }]);
import ProcurementRequest, { PROCUREMENT_REQUEST_STATUSES } from "../models/ProcurementRequest.js";
import ProcurementQuotation from "../models/ProcurementQuotation.js";
import Evidence from "../models/Evidence.js";
import { createCustomerNotification } from "./notificationService.js";
import { conflict, documentMetadata, fingerprint as createFingerprint, idText, isObjectId, pageInput, pagination, requireIdempotencyKey, unavailable } from "./customerDomainService.js";
import { writeAuditLog } from "./auditService.js";

const requestDto = (item) => ({
  id: idText(item._id),
  organisationName: item.organisationName,
  organisationType: item.organisationType,
  contactName: item.contactName,
  contactEmail: item.contactEmail,
  contactPhone: item.contactPhone,
  requirements: (item.requirements || []).map((line) => ({
    id: idText(line._id),
    category: line.category,
    quantity: line.quantity,
    minimumSpecifications: line.minimumSpecifications,
    preferredCondition: line.preferredCondition,
    notes: line.notes || null,
  })),
  budgetRange: { minimum: item.budgetMin, maximum: item.budgetMax },
  requiredBy: item.requiredBy || null,
  fulfilmentMode: item.fulfilmentMode,
  fulfilmentLocation: item.fulfilmentLocation || null,
  softwareAndLicensingNeeds: item.softwareAndLicensingNeeds || null,
  warrantyAndSupportNeeds: item.warrantyAndSupportNeeds || null,
  setupDeploymentNeeds: item.setupDeploymentNeeds || null,
  accessibilityNeeds: item.accessibilityNeeds || null,
  notes: item.notes || null,
  status: item.status,
  version: item.version,
  timeline: (item.timeline || []).map((event) => ({ status: event.status, at: event.at, message: event.message || null })),
  clarifications: (item.clarifications || []).map((item) => ({
    id: idText(item._id),
    question: item.question,
    response: item.response || null,
    requestedAt: item.requestedAt,
    respondedAt: item.respondedAt || null,
  })),
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

const quoteDto = async (quote) => {
  const evidence = quote.documentEvidence ? await Evidence.findById(quote.documentEvidence).select("_id displayName detectedMimeType createdAt").lean() : null;
  return {
    id: idText(quote._id),
    requestId: idText(quote.request),
    version: quote.version,
    lineItems: (quote.lineItems || []).map((line) => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, totalAmount: line.totalAmount })),
    subtotal: quote.subtotal,
    tax: quote.tax,
    fees: quote.fees,
    fulfilmentCharge: quote.fulfilmentCharge,
    totalAmount: quote.totalAmount,
    currency: quote.currency,
    validUntil: quote.validUntil,
    termsVersion: quote.termsVersion,
    warrantySummary: quote.warrantySummary || null,
    supportSummary: quote.supportSummary || null,
    status: quote.status,
    superseded: Boolean(quote.superseded),
    conversionStatus: quote.conversionStatus,
    orderId: quote.order ? idText(quote.order) : null,
    document: documentMetadata(evidence),
    createdAt: quote.createdAt,
  };
};

const customerRequest = async (id, owner) => {
  if (!isObjectId(id)) throw unavailable("Procurement request");
  const request = await ProcurementRequest.findOne({ _id: id, customer: owner });
  if (!request) throw unavailable("Procurement request");
  return request;
};

const ensureRequirements = (requirements) => {
  if (!Array.isArray(requirements) || !requirements.length || requirements.length > 25) throw invalid("Procurement requirements are invalid");
  return requirements.map((line) => {
    if (!line || typeof line.category !== "string" || !line.category.trim() || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10000 || typeof line.minimumSpecifications !== "string" || !line.minimumSpecifications.trim()) {
      throw invalid("Each procurement requirement needs a category, quantity, and minimum specifications");
    }
    return {
      category: line.category.trim(),
      quantity: line.quantity,
      minimumSpecifications: line.minimumSpecifications.trim(),
      preferredCondition: ["new", "refurbished", "either"].includes(line.preferredCondition) ? line.preferredCondition : "either",
      notes: typeof line.notes === "string" ? line.notes.trim().slice(0, 1000) : null,
    };
  });
};

export const createRequest = async ({ owner, input, idempotencyKey }) => {
  const key = requireIdempotencyKey(idempotencyKey);
  const fields = ["organisationName", "organisationType", "contactName", "contactEmail", "contactPhone"];
  for (const field of fields) if (typeof input[field] !== "string" || !input[field].trim()) throw invalid(`${field} is required`);
  if (!["business", "school", "nonprofit", "government", "other"].includes(input.organisationType)) throw invalid("Organisation type is invalid");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.contactEmail.trim())) throw invalid("Contact email is invalid");
  const requirements = ensureRequirements(input.requirements);
  const normalized = {
    organisationName: input.organisationName.trim(),
    organisationType: input.organisationType,
    contactName: input.contactName.trim(),
    contactEmail: input.contactEmail.trim().toLowerCase(),
    contactPhone: input.contactPhone.trim(),
    requirements,
    budgetMin: Number.isSafeInteger(input.budgetMin) && input.budgetMin >= 0 ? input.budgetMin : null,
    budgetMax: Number.isSafeInteger(input.budgetMax) && input.budgetMax >= 0 ? input.budgetMax : null,
    requiredBy: input.requiredBy ? new Date(input.requiredBy) : null,
    fulfilmentMode: ["delivery", "pickup", "either"].includes(input.fulfilmentMode) ? input.fulfilmentMode : "either",
    fulfilmentLocation: typeof input.fulfilmentLocation === "string" ? input.fulfilmentLocation.trim().slice(0, 500) : null,
    softwareAndLicensingNeeds: typeof input.softwareAndLicensingNeeds === "string" ? input.softwareAndLicensingNeeds.trim().slice(0, 2000) : null,
    warrantyAndSupportNeeds: typeof input.warrantyAndSupportNeeds === "string" ? input.warrantyAndSupportNeeds.trim().slice(0, 2000) : null,
    setupDeploymentNeeds: typeof input.setupDeploymentNeeds === "string" ? input.setupDeploymentNeeds.trim().slice(0, 2000) : null,
    accessibilityNeeds: typeof input.accessibilityNeeds === "string" ? input.accessibilityNeeds.trim().slice(0, 2000) : null,
    notes: typeof input.notes === "string" ? input.notes.trim().slice(0, 3000) : null,
  };
  if (normalized.budgetMin != null && normalized.budgetMax != null && normalized.budgetMin > normalized.budgetMax) throw invalid("Budget maximum must be at least budget minimum");
  if (normalized.requiredBy && Number.isNaN(normalized.requiredBy.valueOf())) throw invalid("Required date is invalid");
  const hash = createFingerprint(normalized);

  const existing = await ProcurementRequest.findOne({ customer: owner, idempotencyKey: key });
  if (existing) {
    if (existing.idempotencyFingerprint !== hash) throw conflict("procurement_idempotency_conflict", "This idempotency key is already associated with a different request");
    return requestDto(existing);
  }

  try {
    const request = await ProcurementRequest.create({ customer: owner, ...normalized, idempotencyKey: key, idempotencyFingerprint: hash });
    await writeAuditLog(owner, "CUSTOMER_PROCUREMENT_REQUEST_CREATED", "ProcurementRequest", request._id, { status: request.status, requirementCount: requirements.length });
    return requestDto(request);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const replay = await ProcurementRequest.findOne({ customer: owner, idempotencyKey: key });
    if (!replay || replay.idempotencyFingerprint !== hash) throw conflict("procurement_idempotency_conflict", "This idempotency key is already associated with a different request");
    return requestDto(replay);
  }
};

export const listRequests = async ({ owner, query }) => {
  const { page, limit, skip } = pageInput(query);
  const [items, total] = await Promise.all([
    ProcurementRequest.find({ customer: owner }).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    ProcurementRequest.countDocuments({ customer: owner }),
  ]);
  return { requests: items.map(requestDto), pagination: pagination(page, limit, total) };
};

export const getRequest = async ({ owner, id }) => requestDto(await customerRequest(id, owner));

export const updateRequest = async ({ owner, id, input }) => {
  const request = await customerRequest(id, owner);
  if (!["SUBMITTED", "CLARIFICATION_REQUIRED"].includes(request.status)) throw conflict("procurement_edit_unavailable", "This request can no longer be edited");

  if (input.version !== undefined && Number.isSafeInteger(input.version) && request.version !== input.version) {
    throw conflict("procurement_version_conflict", "Procurement request has been modified by another request");
  }

  if (input.requirements !== undefined) request.requirements = ensureRequirements(input.requirements);
  for (const field of ["organisationName", "contactName", "contactEmail", "contactPhone", "fulfilmentLocation", "softwareAndLicensingNeeds", "warrantyAndSupportNeeds", "setupDeploymentNeeds", "accessibilityNeeds", "notes"]) {
    if (typeof input[field] === "string") request[field] = input[field].trim();
  }
  if (Number.isSafeInteger(input.budgetMin) && input.budgetMin >= 0) request.budgetMin = input.budgetMin;
  if (Number.isSafeInteger(input.budgetMax) && input.budgetMax >= 0) request.budgetMax = input.budgetMax;
  if (request.budgetMin != null && request.budgetMax != null && request.budgetMin > request.budgetMax) throw invalid("Budget maximum must be at least budget minimum");

  const currentVersion = request.version;
  request.version += 1;
  request.timeline.push({ status: request.status, at: new Date(), message: "Customer updated the request" });

  const updated = await ProcurementRequest.findOneAndUpdate(
    { _id: request._id, customer: owner, version: currentVersion },
    {
      $set: {
        organisationName: request.organisationName,
        contactName: request.contactName,
        contactEmail: request.contactEmail,
        contactPhone: request.contactPhone,
        requirements: request.requirements,
        budgetMin: request.budgetMin,
        budgetMax: request.budgetMax,
        fulfilmentLocation: request.fulfilmentLocation,
        softwareAndLicensingNeeds: request.softwareAndLicensingNeeds,
        warrantyAndSupportNeeds: request.warrantyAndSupportNeeds,
        setupDeploymentNeeds: request.setupDeploymentNeeds,
        accessibilityNeeds: request.accessibilityNeeds,
        notes: request.notes,
        version: request.version,
      },
      $push: { timeline: { status: request.status, at: new Date(), message: "Customer updated the request" } },
    },
    { returnDocument: "after" }
  );

  if (!updated) {
    throw conflict("procurement_version_conflict", "Procurement request was concurrently modified");
  }

  await writeAuditLog(owner, "CUSTOMER_PROCUREMENT_REQUEST_UPDATED", "ProcurementRequest", updated._id, { version: updated.version });
  return requestDto(updated);
};

export const respondClarification = async ({ owner, id, clarificationId, response }) => {
  const request = await customerRequest(id, owner);
  if (request.status !== "CLARIFICATION_REQUIRED") throw conflict("procurement_clarification_unavailable", "This request is not awaiting clarification");

  const clarification = request.clarifications.id(clarificationId);
  if (!clarification || clarification.response) throw unavailable("Procurement clarification");
  if (typeof response !== "string" || response.trim().length < 1 || response.trim().length > 1000) throw invalid("Clarification response is invalid");

  clarification.response = response.trim();
  clarification.respondedAt = new Date();
  request.status = "UNDER_REVIEW";
  request.timeline.push({ status: request.status, at: new Date(), message: "Clarification received" });

  await request.save();
  await writeAuditLog(owner, "CUSTOMER_PROCUREMENT_CLARIFICATION_RESPONDED", "ProcurementRequest", request._id, {});
  return requestDto(request);
};

export const listQuotations = async ({ owner, requestId }) => {
  await customerRequest(requestId, owner);
  const quotes = await ProcurementQuotation.find({ request: requestId, customer: owner }).sort({ version: -1 });
  return Promise.all(quotes.map(quoteDto));
};

export const getQuotation = async ({ owner, id }) => {
  if (!isObjectId(id)) throw unavailable("Procurement quotation");
  const quote = await ProcurementQuotation.findOne({ _id: id, customer: owner });
  if (!quote) throw unavailable("Procurement quotation");
  return quoteDto(quote);
};

export const decideQuotation = async ({ owner, id, decision, version, idempotencyKey }) => {
  if (!isObjectId(id) || !["approve", "decline"].includes(decision) || !Number.isSafeInteger(version)) throw unavailable("Procurement quotation");
  const key = requireIdempotencyKey(idempotencyKey);
  const now = new Date();

  const session = await mongoose.startSession();
  try {
    let quote;
    await session.withTransaction(async () => {
      const existing = await ProcurementQuotation.findOne({ _id: id, customer: owner }).session(session);
      if (!existing) throw unavailable("Procurement quotation");
      if (existing.decision?.type) {
        if (existing.decision.idempotencyKey === key && existing.decision.type === (decision === "approve" ? "APPROVED" : "DECLINED")) {
          quote = existing;
          return;
        }
        throw conflict("procurement_quote_decided", "This quotation has already been decided");
      }
      if (existing.version !== version || existing.superseded || !existing.isActionable || existing.status !== "ISSUED" || existing.validUntil <= now) {
        if (existing.validUntil <= now && existing.status === "ISSUED") {
          existing.status = "EXPIRED";
          existing.isActionable = false;
          await existing.save({ session });
        }
        throw conflict(existing.validUntil <= now ? "procurement_quote_expired" : "procurement_quote_not_actionable", "This quotation is no longer actionable");
      }

      existing.status = decision === "approve" ? "APPROVED" : "DECLINED";
      existing.isActionable = false;
      existing.decision = { type: decision === "approve" ? "APPROVED" : "DECLINED", at: now, idempotencyKey: key, version };
      await existing.save({ session });
      quote = existing;

      const request = await ProcurementRequest.findOne({ _id: existing.request, customer: owner }).session(session);
      if (!request) throw unavailable("Procurement request");
      request.status = decision === "approve" ? "CONVERSION_PENDING" : "DECLINED";
      request.timeline.push({ status: request.status, at: now, message: decision === "approve" ? "Quotation approved; order conversion is pending." : "Quotation declined" });
      await request.save({ session });

      await writeAuditLog(owner, decision === "approve" ? "CUSTOMER_PROCUREMENT_QUOTE_APPROVED" : "CUSTOMER_PROCUREMENT_QUOTE_DECLINED", "ProcurementQuotation", existing._id, { version: existing.version }, session);
    });
    return quoteDto(quote);
  } finally {
    await session.endSession();
  }
};

export const createStaffQuotation = async ({ actor, requestId, input }) => {
  if (!isObjectId(requestId)) throw unavailable("Procurement request");
  const request = await ProcurementRequest.findById(requestId);
  if (!request) throw unavailable("Procurement request");

  const lines = input.lineItems;
  if (!Array.isArray(lines) || !lines.length) throw invalid("Quotation requires line items");

  const nextVersion = ((await ProcurementQuotation.findOne({ request: request._id }).sort({ version: -1 }).lean())?.version || 0) + 1;
  await ProcurementQuotation.updateMany({ request: request._id, isActionable: true }, { $set: { isActionable: false, superseded: true, status: "SUPERSEDED" } });

  const quote = await ProcurementQuotation.create({
    request: request._id,
    customer: request.customer,
    version: nextVersion,
    lineItems: lines,
    subtotal: input.subtotal,
    tax: input.tax || 0,
    fees: input.fees || 0,
    fulfilmentCharge: input.fulfilmentCharge || 0,
    totalAmount: input.totalAmount,
    validUntil: input.validUntil,
    termsVersion: input.termsVersion,
    warrantySummary: input.warrantySummary || null,
    supportSummary: input.supportSummary || null,
    documentEvidence: input.documentEvidence || null,
  });

  request.status = "AWAITING_DECISION";
  request.timeline.push({ status: request.status, at: new Date(), message: "A quotation is ready for review." });
  await request.save();

  await createCustomerNotification({
    recipient: request.customer,
    type: "procurement_quotation_issued",
    title: "Procurement quotation ready",
    safePreview: "A quotation is ready for your review.",
    resourceType: "procurement_quotation",
    resourceId: quote._id,
    eventKey: `procurement-quote:${quote._id}`,
  });

  await writeAuditLog(actor, "CUSTOMER_PROCUREMENT_QUOTE_ISSUED", "ProcurementQuotation", quote._id, { version: quote.version });
  return quoteDto(quote);
};
