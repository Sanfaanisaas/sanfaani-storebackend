import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { customerMutationLimiter } from "../middleware/rateLimiter.js";
import { USER_ROLES } from "../utils/constants.js";
import { getServicePolicy, createCustomerServiceRequest, listCustomerServiceRequests, getCustomerServiceRequest, listCustomerServiceQuotes, getCustomerServiceQuote, decideCustomerServiceQuote, recordStaffAssessment, createStaffServiceQuotation, listCustomerServiceHistory, getCustomerServiceHistory } from "../controllers/customerServicesController.js";
import { createServiceRequestSchema, createStaffServiceQuoteSchema, decideServiceQuoteSchema, getServiceRequestsQuerySchema, recordStaffAssessmentSchema, serviceQuoteIdParamSchema, serviceRequestIdParamSchema } from "../utils/validators/customerServicesValidators.js";

const router = Router();

/**
 * @swagger
 * /services/policy:
 *   get:
 *     summary: Get service responsibility policy
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Responsibility policy details
 */
router.get("/policy", authenticate, getServicePolicy);

/**
 * @swagger
 * /services/requests:
 *   post:
 *     summary: Create customer service request
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       201:
 *         description: Service request created
 *       400:
 *         description: Validation failed
 */
router.post("/requests", authenticate, customerMutationLimiter, validate(createServiceRequestSchema, "body"), createCustomerServiceRequest);

/**
 * @swagger
 * /services/requests/mine:
 *   get:
 *     summary: List customer service requests
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Owner service requests list
 */
router.get("/requests/mine", authenticate, validate(getServiceRequestsQuerySchema, "query"), listCustomerServiceRequests);

/**
 * @swagger
 * /services/requests/{id}:
 *   get:
 *     summary: Get service request detail
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Owner service request detail
 *       404:
 *         description: Request unavailable or not owned
 */
router.get("/requests/:id", authenticate, validate(serviceRequestIdParamSchema, "params"), getCustomerServiceRequest);

/**
 * @swagger
 * /services/requests/{id}/assessment:
 *   get:
 *     summary: Get service request assessment
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Service request assessment detail
 */
router.get("/requests/:id/assessment", authenticate, validate(serviceRequestIdParamSchema, "params"), getCustomerServiceRequest);

/**
 * @swagger
 * /services/requests/{id}/quotations:
 *   get:
 *     summary: List quotations for service request
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Service quotations list
 */
router.get("/requests/:id/quotations", authenticate, validate(serviceRequestIdParamSchema, "params"), listCustomerServiceQuotes);

/**
 * @swagger
 * /services/requests/{id}/assessment:
 *   patch:
 *     summary: Record staff compatibility assessment (Staff)
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [result]
 *     responses:
 *       200:
 *         description: Assessment recorded
 *       403:
 *         description: Staff role required
 */
router.patch(
  "/requests/:id/assessment",
  authenticate,
  authorize(USER_ROLES.TECHNICIAN, USER_ROLES.SALES_ADVISOR, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  validate(serviceRequestIdParamSchema, "params"),
  validate(recordStaffAssessmentSchema, "body"),
  recordStaffAssessment
);

/**
 * @swagger
 * /services/requests/{id}/quotations:
 *   post:
 *     summary: Create service quotation (Staff)
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       201:
 *         description: Service quotation created
 *       409:
 *         description: Request is incompatible
 */
router.post(
  "/requests/:id/quotations",
  authenticate,
  authorize(USER_ROLES.SALES_ADVISOR, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  validate(serviceRequestIdParamSchema, "params"),
  validate(createStaffServiceQuoteSchema, "body"),
  createStaffServiceQuotation
);

/**
 * @swagger
 * /services/quotations/{id}:
 *   get:
 *     summary: Get service quotation detail
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Owner service quotation detail
 *       404:
 *         description: Quotation unavailable or not owned
 */
router.get("/quotations/:id", authenticate, validate(serviceQuoteIdParamSchema, "params"), getCustomerServiceQuote);

/**
 * @swagger
 * /services/quotations/{id}/approve:
 *   post:
 *     summary: Approve service quotation
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [version]
 *     responses:
 *       200:
 *         description: Quotation approved
 *       409:
 *         description: Quotation expired, superseded, or decided
 */
router.post(
  "/quotations/:id/approve",
  authenticate,
  customerMutationLimiter,
  validate(serviceQuoteIdParamSchema, "params"),
  validate(decideServiceQuoteSchema, "body"),
  decideCustomerServiceQuote("approve")
);

/**
 * @swagger
 * /services/quotations/{id}/decline:
 *   post:
 *     summary: Decline service quotation
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [version]
 *     responses:
 *       200:
 *         description: Quotation declined
 *       409:
 *         description: Quotation expired, superseded, or decided
 */
router.post(
  "/quotations/:id/decline",
  authenticate,
  customerMutationLimiter,
  validate(serviceQuoteIdParamSchema, "params"),
  validate(decideServiceQuoteSchema, "body"),
  decideCustomerServiceQuote("decline")
);

/**
 * @swagger
 * /services/history:
 *   get:
 *     summary: List customer service history
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Owner service history list
 */
router.get("/history", authenticate, validate(getServiceRequestsQuerySchema, "query"), listCustomerServiceHistory);

/**
 * @swagger
 * /services/history/{id}:
 *   get:
 *     summary: Get customer service history detail
 *     tags: [CustomerServices]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Owner service history detail
 *       404:
 *         description: History entry unavailable
 */
router.get("/history/:id", authenticate, validate(serviceRequestIdParamSchema, "params"), getCustomerServiceHistory);

export default router;
