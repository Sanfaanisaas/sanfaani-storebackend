import { catchAsync } from "../utils/catchAsync.js";
import * as services from "../services/customerServicesService.js";
import * as execution from "../services/serviceExecutionService.js";
import * as planAdmin from "../services/maintenancePlanAdminService.js";
export const getServicePolicy = catchAsync(async (req, res) => res.json({ success: true, data: services.getPolicy() }));
export const createCustomerServiceRequest = catchAsync(async (req, res) => res.status(201).json({ success: true, data: await services.createServiceRequest({ customer: req.user.id, input: req.body, idempotencyKey: req.get("Idempotency-Key") }) }));
export const listCustomerServiceRequests = catchAsync(async (req, res) => res.json({ success: true, data: await services.listServiceRequests({ customer: req.user.id, query: req.query }) }));
export const getCustomerServiceRequest = catchAsync(async (req, res) => res.json({ success: true, data: await services.getServiceRequest({ customer: req.user.id, id: req.params.id }) }));
export const listCustomerServiceQuotes = catchAsync(async (req, res) => res.json({ success: true, data: await services.listServiceQuotations({ customer: req.user.id, requestId: req.params.id }) }));
export const getCustomerServiceQuote = catchAsync(async (req, res) => res.json({ success: true, data: await services.getServiceQuote({ customer: req.user.id, id: req.params.id }) }));
export const decideCustomerServiceQuote = (decision) => catchAsync(async (req, res) => res.json({ success: true, data: await services.decideServiceQuote({ customer: req.user.id, id: req.params.id, decision, version: req.body.version, idempotencyKey: req.get("Idempotency-Key") }) }));
export const recordStaffAssessment = catchAsync(async (req, res) => res.json({ success: true, data: await services.recordAssessment({ actor: req.user.id, requestId: req.params.id, assessment: req.body }) }));
export const createStaffServiceQuotation = catchAsync(async (req, res) => res.status(201).json({ success: true, data: await services.createStaffServiceQuote({ actor: req.user.id, requestId: req.params.id, input: req.body }) }));
export const listCustomerMaintenancePlans = catchAsync(async (req, res) => res.json({ success: true, data: await services.listMaintenancePlans({ customer: req.user.id, query: req.query }) }));
export const getCustomerMaintenancePlan = catchAsync(async (req, res) => res.json({ success: true, data: await services.getMaintenancePlan({ customer: req.user.id, id: req.params.id }) }));
export const listCustomerServiceHistory = catchAsync(async (req, res) => res.json({ success: true, data: await services.listServiceHistory({ customer: req.user.id, query: req.query }) }));
export const getCustomerServiceHistory = catchAsync(async (req, res) => res.json({ success: true, data: await services.getServiceHistory({ customer: req.user.id, id: req.params.id }) }));
export const scheduleStaffService = catchAsync(async (req, res) => {
  const result = await execution.scheduleService({ actor: req.user.id, requestId: req.params.id, input: req.body, idempotencyKey: req.get("Idempotency-Key") });
  res.status(result.created ? 201 : 200).json({ success: true, data: result.execution });
});
export const startStaffService = catchAsync(async (req, res) => res.json({ success: true, data: await execution.startService({ actor: req.user.id, executionId: req.params.id, expectedVersion: req.body.expectedVersion, idempotencyKey: req.get("Idempotency-Key") }) }));
export const completeStaffService = catchAsync(async (req, res) => res.json({ success: true, data: await execution.completeService({ actor: req.user.id, executionId: req.params.id, input: req.body, idempotencyKey: req.get("Idempotency-Key") }) }));
export const cancelStaffService = catchAsync(async (req, res) => res.json({ success: true, data: await execution.cancelService({ actor: req.user.id, executionId: req.params.id, expectedVersion: req.body.expectedVersion, reason: req.body.reason, idempotencyKey: req.get("Idempotency-Key") }) }));
export const createStaffMaintenancePlan = catchAsync(async (req, res) => {
  const result = await planAdmin.createPlan({ actor: req.user.id, input: req.body, idempotencyKey: req.get("Idempotency-Key") });
  res.status(result.created ? 201 : 200).json({ success: true, data: result.plan });
});
export const listStaffMaintenancePlans = catchAsync(async (req, res) => res.json({ success: true, data: await planAdmin.listPlansForStaff({ actor: req.user.id, query: req.query }) }));
export const updateStaffMaintenancePlan = catchAsync(async (req, res) => res.json({ success: true, data: await planAdmin.updatePlan({ actor: req.user.id, planId: req.params.id, input: req.body }) }));
export const cancelStaffMaintenancePlan = catchAsync(async (req, res) => res.json({ success: true, data: await planAdmin.cancelPlan({ actor: req.user.id, planId: req.params.id, input: req.body, idempotencyKey: req.get("Idempotency-Key") }) }));
export const renewStaffMaintenancePlan = catchAsync(async (req, res) => {
  const result = await planAdmin.renewPlan({ actor: req.user.id, planId: req.params.id, input: req.body, idempotencyKey: req.get("Idempotency-Key") });
  res.status(result.created ? 201 : 200).json({ success: true, data: result.plan });
});
