import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { customerMutationLimiter } from "../middleware/rateLimiter.js";
import { USER_ROLES } from "../utils/constants.js";
import { createSupplier, createPurchaseOrder, approvePurchaseOrder, receivePurchaseOrder } from "../controllers/procurementController.js";
import { createCustomerProcurementRequest, listCustomerProcurementRequests, getCustomerProcurementRequest, patchCustomerProcurementRequest, respondCustomerProcurementClarification, listCustomerProcurementQuotations, getCustomerProcurementQuotation, decideCustomerProcurementQuotation, createStaffCustomerProcurementQuotation } from "../controllers/procurementCustomerController.js";
import { createProcurementRequestSchema, createStaffProcurementQuotationSchema, decideProcurementQuotationSchema, getProcurementRequestsQuerySchema, patchProcurementRequestSchema, procurementClarificationParamSchema, procurementQuotationIdParamSchema, procurementRequestIdParamSchema, respondProcurementClarificationSchema } from "../utils/validators/procurementCustomerValidators.js";

const router = Router();
const manage = [USER_ROLES.INVENTORY_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN];

// BE-08 / Internal staff procurement routes
router.post("/suppliers", authenticate, authorize(...manage), createSupplier);
router.post("/purchase-orders", authenticate, authorize(...manage), createPurchaseOrder);
router.post("/purchase-orders/:id/approve", authenticate, authorize(USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN), approvePurchaseOrder);
router.post("/purchase-orders/:id/receipts", authenticate, authorize(...manage), receivePurchaseOrder);

// BE-10 / Customer procurement routes

/**
 * @swagger
 * /procurement/requests:
 *   post:
 *     summary: Create customer procurement request
 *     tags: [Procurement]
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
 *         description: Procurement request created
 *       400:
 *         description: Validation failed
 */
router.post("/requests", authenticate, customerMutationLimiter, validate(createProcurementRequestSchema, "body"), createCustomerProcurementRequest);

/**
 * @swagger
 * /procurement/requests/mine:
 *   get:
 *     summary: List customer procurement requests
 *     tags: [Procurement]
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
 *         description: Owner procurement requests list
 */
router.get("/requests/mine", authenticate, validate(getProcurementRequestsQuerySchema, "query"), listCustomerProcurementRequests);

/**
 * @swagger
 * /procurement/requests/{id}:
 *   get:
 *     summary: Get procurement request detail
 *     tags: [Procurement]
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
 *         description: Owner procurement request detail
 *       404:
 *         description: Request unavailable or not owned
 */
router.get("/requests/:id", authenticate, validate(procurementRequestIdParamSchema, "params"), getCustomerProcurementRequest);

/**
 * @swagger
 * /procurement/requests/{id}:
 *   patch:
 *     summary: Update editable procurement request
 *     tags: [Procurement]
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
 *       200:
 *         description: Procurement request updated
 *       409:
 *         description: Request non-editable or version conflict
 */
router.patch("/requests/:id", authenticate, customerMutationLimiter, validate(procurementRequestIdParamSchema, "params"), validate(patchProcurementRequestSchema, "body"), patchCustomerProcurementRequest);

/**
 * @swagger
 * /procurement/requests/{id}/clarifications/{clarificationId}:
 *   post:
 *     summary: Respond to procurement clarification request
 *     tags: [Procurement]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: clarificationId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [response]
 *     responses:
 *       200:
 *         description: Clarification response recorded
 */
router.post(
  "/requests/:id/clarifications/:clarificationId",
  authenticate,
  customerMutationLimiter,
  validate(procurementClarificationParamSchema, "params"),
  validate(respondProcurementClarificationSchema, "body"),
  respondCustomerProcurementClarification
);

/**
 * @swagger
 * /procurement/requests/{id}/quotations:
 *   get:
 *     summary: List quotations for procurement request
 *     tags: [Procurement]
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
 *         description: Customer-visible procurement quotations list
 */
router.get("/requests/:id/quotations", authenticate, validate(procurementRequestIdParamSchema, "params"), listCustomerProcurementQuotations);

/**
 * @swagger
 * /procurement/requests/{id}/quotations:
 *   post:
 *     summary: Issue procurement quotation (Staff)
 *     tags: [Procurement]
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
 *         description: Procurement quotation created
 *       403:
 *         description: Staff role required
 */
router.post(
  "/requests/:id/quotations",
  authenticate,
  authorize(USER_ROLES.SALES_ADVISOR, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  validate(procurementRequestIdParamSchema, "params"),
  validate(createStaffProcurementQuotationSchema, "body"),
  createStaffCustomerProcurementQuotation
);

/**
 * @swagger
 * /procurement/quotations/{id}:
 *   get:
 *     summary: Get procurement quotation detail
 *     tags: [Procurement]
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
 *         description: Owner procurement quotation detail
 *       404:
 *         description: Quotation unavailable or not owned
 */
router.get("/quotations/:id", authenticate, validate(procurementQuotationIdParamSchema, "params"), getCustomerProcurementQuotation);

/**
 * @swagger
 * /procurement/quotations/{id}/approve:
 *   post:
 *     summary: Approve procurement quotation
 *     tags: [Procurement]
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
  validate(procurementQuotationIdParamSchema, "params"),
  validate(decideProcurementQuotationSchema, "body"),
  decideCustomerProcurementQuotation("approve")
);

/**
 * @swagger
 * /procurement/quotations/{id}/decline:
 *   post:
 *     summary: Decline procurement quotation
 *     tags: [Procurement]
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
  validate(procurementQuotationIdParamSchema, "params"),
  validate(decideProcurementQuotationSchema, "body"),
  decideCustomerProcurementQuotation("decline")
);

export default router;
