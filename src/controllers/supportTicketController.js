import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import SupportTicket from "../models/SupportTicket.js";
import Order from "../models/Order.js";
import Repair from "../models/Repair.js";
import Warranty from "../models/Warranty.js";
import Claim from "../models/Claim.js";
import ReturnRequest from "../models/ReturnRequest.js";
import GuidanceSession from "../models/GuidanceSession.js";
import ProcurementRequest from "../models/ProcurementRequest.js";
import ServiceRequest from "../models/ServiceRequest.js";
import { USER_ROLES, SUPPORT_TICKET_STATUS } from "../utils/constants.js";
import { createCustomerNotification } from "../services/notificationService.js";
import { fingerprint, idText, isObjectId, listEvidenceSummaries, pageInput, pagination, requireIdempotencyKey, unavailable, conflict } from "../services/customerDomainService.js";
import { writeAuditLog } from "../services/auditService.js";

const staffRoles = new Set([USER_ROLES.SUPPORT_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN]);
const customerReplyStatuses = new Set(["open", "in_progress", "waiting_for_customer"]);
const resourceModels = {
  order: [Order, "userId"], repair: [Repair, "customer"], warranty: [Warranty, "customer"],
  claim: [Claim, "submittedBy"], return: [ReturnRequest, "owner"], guidance: [GuidanceSession, "owner"],
  procurement_request: [ProcurementRequest, "customer"], service_request: [ServiceRequest, "customer"],
};
const safeTicket = async (ticket) => ({
  id: idText(ticket._id), subject: ticket.subject, category: ticket.category, priority: ticket.priority,
  status: ticket.status, responseExpectation: ticket.responseExpectation || null, customerSafeSla: ticket.customerSafeSla || null,
  linkedResource: ticket.linkedResource?.type && ticket.linkedResource?.id ? { type: ticket.linkedResource.type, id: idText(ticket.linkedResource.id) } : null,
  nextAction: ticket.nextAction || null, resolutionSummary: ticket.resolutionSummary || null,
  conversation: ticket.messages.map((message) => ({ id: idText(message._id), authorType: message.authorType || "support", body: message.body, createdAt: message.createdAt })),
  evidence: await listEvidenceSummaries({ owner: ticket.customer, subjectType: "support_ticket", subject: ticket._id }),
  createdAt: ticket.createdAt, updatedAt: ticket.updatedAt,
});
const getOwnedTicket = async (id, owner) => {
  if (!isObjectId(id)) throw unavailable("Support ticket");
  const ticket = await SupportTicket.findOne({ _id: id, customer: owner });
  if (!ticket) throw unavailable("Support ticket");
  return ticket;
};
const validateLinkedResource = async (owner, value) => {
  if (!value) return null;
  if (!value || typeof value !== "object" || !resourceModels[value.type] || !isObjectId(value.id)) throw new AppError("Linked resource is invalid", 400, [{ code: "linked_resource_invalid", message: "Choose a supported resource from your account" }]);
  const [Model, ownerField] = resourceModels[value.type];
  const resource = await Model.findOne({ _id: value.id, [ownerField]: owner }).select("_id").lean();
  if (!resource) throw unavailable("Support resource");
  return { type: value.type, id: resource._id };
};
export const createSupportTicket = catchAsync(async (req, res) => {
  const key = requireIdempotencyKey(req.get("Idempotency-Key"));
  const { subject, message, category = "general", priority = "normal" } = req.body;
  if (typeof subject !== "string" || subject.trim().length < 3 || subject.trim().length > 200 || typeof message !== "string" || message.trim().length < 5 || message.trim().length > 4000) throw new AppError("Support ticket input is invalid", 400, [{ code: "support_ticket_input_invalid", message: "Provide a subject and message within the allowed limits" }]);
  if (!["general", "order", "repair", "warranty", "claim", "return", "guidance", "procurement", "service"].includes(category) || !["normal", "high"].includes(priority)) throw new AppError("Support category or priority is invalid", 400);
  const linkedResource = await validateLinkedResource(req.user.id, req.body.linkedResource || (req.body.relatedOrder ? { type: "order", id: req.body.relatedOrder } : req.body.relatedRepair ? { type: "repair", id: req.body.relatedRepair } : null));
  const normalized = { subject: subject.trim(), message: message.trim(), category, priority, linkedResource: linkedResource ? { type: linkedResource.type, id: linkedResource.id.toString() } : null };
  const hash = fingerprint(normalized);
  const existing = await SupportTicket.findOne({ customer: req.user.id, idempotencyKey: key });
  if (existing) { if (existing.idempotencyFingerprint !== hash) throw conflict("support_ticket_idempotency_conflict", "This idempotency key is already associated with a different ticket"); return res.json({ success: true, data: await safeTicket(existing) }); }
  try {
    const ticket = await SupportTicket.create({ customer: req.user.id, subject: normalized.subject, category, priority, linkedResource, relatedOrder: linkedResource?.type === "order" ? linkedResource.id : null, relatedRepair: linkedResource?.type === "repair" ? linkedResource.id : null, status: SUPPORT_TICKET_STATUS.OPEN, messages: [{ author: req.user.id, authorType: "customer", body: normalized.message, idempotencyKey: key }], idempotencyKey: key, idempotencyFingerprint: hash, responseExpectation: "A support representative will review this request.", nextAction: "Wait for a support response." });
    await writeAuditLog(req.user.id, "SUPPORT_TICKET_CREATED", "SupportTicket", ticket._id, { category });
    res.status(201).json({ success: true, data: await safeTicket(ticket) });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const replay = await SupportTicket.findOne({ customer: req.user.id, idempotencyKey: key });
    if (!replay || replay.idempotencyFingerprint !== hash) throw conflict("support_ticket_idempotency_conflict", "This idempotency key is already associated with a different ticket");
    res.json({ success: true, data: await safeTicket(replay) });
  }
});
export const getMyTickets = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageInput(req.query);
  const [items, total] = await Promise.all([SupportTicket.find({ customer: req.user.id }).sort({ updatedAt: -1 }).skip(skip).limit(limit), SupportTicket.countDocuments({ customer: req.user.id })]);
  res.json({ success: true, data: { tickets: await Promise.all(items.map(safeTicket)), pagination: pagination(page, limit, total) } });
});
export const getTicketDetail = catchAsync(async (req, res) => res.json({ success: true, data: await safeTicket(await getOwnedTicket(req.params.id, req.user.id)) }));
export const replyToTicket = catchAsync(async (req, res) => {
  const key = requireIdempotencyKey(req.get("Idempotency-Key")); const body = typeof req.body.body === "string" ? req.body.body.trim() : "";
  if (!body || body.length > 4000) throw new AppError("Support reply is invalid", 400, [{ code: "support_reply_invalid", message: "Provide a reply within the allowed limit" }]);
  const ticket = await SupportTicket.findById(req.params.id);
  if (!ticket) throw unavailable("Support ticket");
  const owner = ticket.customer.toString() === req.user.id; const staff = staffRoles.has(req.user.role);
  if (!owner && !staff) throw unavailable("Support ticket");
  if (ticket.messages.some((message) => message.idempotencyKey === key)) return res.json({ success: true, data: await safeTicket(ticket) });
  if (owner && !customerReplyStatuses.has(ticket.status)) throw conflict("support_reply_unavailable", "This ticket is not open for customer replies");
  if (!owner && ticket.status === "closed") throw conflict("support_reply_unavailable", "Closed tickets cannot receive replies");
  ticket.messages.push({ author: req.user.id, authorType: staff ? "support" : "customer", body, idempotencyKey: key });
  if (owner && ticket.status === "waiting_for_customer") ticket.status = "waiting_for_support";
  if (staff && ["open", "in_progress", "waiting_for_support"].includes(ticket.status)) ticket.status = "waiting_for_customer";
  await ticket.save(); await writeAuditLog(req.user.id, "SUPPORT_TICKET_REPLIED", "SupportTicket", ticket._id, { actorType: staff ? "support" : "customer" });
  if (staff) await createCustomerNotification({ recipient: ticket.customer, type: "support_reply", title: "New support reply", safePreview: "Support replied to your ticket.", resourceType: "support_ticket", resourceId: ticket._id, mandatory: true, eventKey: `support-reply:${ticket._id}:${ticket.messages.at(-1)._id}` });
  res.status(201).json({ success: true, data: await safeTicket(ticket) });
});
export const updateTicketStatus = catchAsync(async (req, res) => {
  const ticket = await SupportTicket.findById(req.params.id); if (!ticket) throw unavailable("Support ticket");
  const { status, responseExpectation, customerSafeSla, nextAction, resolutionSummary } = req.body;
  if (!Object.values(SUPPORT_TICKET_STATUS).includes(status)) throw new AppError("Support status is invalid", 400);
  ticket.status = status;
  for (const [field, value, max] of [["responseExpectation", responseExpectation, 500], ["customerSafeSla", customerSafeSla, 500], ["nextAction", nextAction, 500], ["resolutionSummary", resolutionSummary, 1500]]) if (typeof value === "string") ticket[field] = value.trim().slice(0, max);
  await ticket.save(); await createCustomerNotification({ recipient: ticket.customer, type: "support_status_updated", title: "Support ticket updated", safePreview: "Your support ticket status has changed.", resourceType: "support_ticket", resourceId: ticket._id, mandatory: true, eventKey: `support-status:${ticket._id}:${ticket.updatedAt.getTime()}` });
  await writeAuditLog(req.user.id, "SUPPORT_TICKET_STATUS_UPDATED", "SupportTicket", ticket._id, { status });
  res.json({ success: true, data: await safeTicket(ticket) });
});
