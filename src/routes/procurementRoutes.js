import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { customerMutationLimiter } from "../middleware/rateLimiter.js";
import { USER_ROLES } from "../utils/constants.js";
import {
  approvePurchaseOrder,
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  createSupplier,
  deactivateSupplier,
  getPurchaseOrder,
  getSupplier,
  listPurchaseOrders,
  listSuppliers,
  receivePurchaseOrder,
  submitPurchaseOrder,
  updateSupplier,
} from "../controllers/procurementController.js";
import { createCustomerProcurementRequest, listCustomerProcurementRequests, getCustomerProcurementRequest, patchCustomerProcurementRequest, respondCustomerProcurementClarification, listCustomerProcurementQuotations, getCustomerProcurementQuotation, decideCustomerProcurementQuotation, createStaffCustomerProcurementQuotation, convertProcurementQuotation } from "../controllers/procurementCustomerController.js";
import { convertProcurementQuotationSchema, createProcurementRequestSchema, createStaffProcurementQuotationSchema, decideProcurementQuotationSchema, getProcurementRequestsQuerySchema, patchProcurementRequestSchema, procurementClarificationParamSchema, procurementQuotationIdParamSchema, procurementRequestIdParamSchema, respondProcurementClarificationSchema } from "../utils/validators/procurementCustomerValidators.js";
import {
  createPurchaseOrderSchema,
  createSupplierSchema,
  deactivateSupplierSchema,
  procurementIdParamSchema,
  purchaseOrderQuerySchema,
  purchaseOrderReasonSchema,
  receivePurchaseOrderSchema,
  supplierQuerySchema,
  updateSupplierSchema,
} from "../utils/validators/procurementValidators.js";

const router = Router();
const manage = [USER_ROLES.INVENTORY_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN];
const govern = [USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN];

// BE-18 / Internal staff procurement routes. Commercial fields are never
// mounted on a customer-accessible route.
/** @swagger
 * /procurement/suppliers:
 *   get:
 *     summary: List private supplier records (authorized inventory staff)
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Private supplier list }
 *       403: { description: Inventory role required }
 *   post:
 *     summary: Create a private supplier record (governance roles)
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Supplier created and audited }
 */
router.route("/suppliers")
  .get(authenticate, authorize(...manage), validate(supplierQuerySchema, "query"), listSuppliers)
  .post(authenticate, authorize(...govern), validate(createSupplierSchema), createSupplier);
/** @swagger
 * /procurement/suppliers/{id}:
 *   get:
 *     summary: Get one private supplier record
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Private supplier detail }
 *       404: { description: Supplier unavailable }
 *   patch:
 *     summary: Update an active supplier with optimistic concurrency
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Supplier updated and audited }
 *       409: { description: Supplier version conflict }
 */
router.route("/suppliers/:id")
  .get(authenticate, authorize(...manage), validate(procurementIdParamSchema, "params"), getSupplier)
  .patch(authenticate, authorize(...govern), validate(procurementIdParamSchema, "params"), validate(updateSupplierSchema), updateSupplier);
/** @swagger
 * /procurement/suppliers/{id}/deactivate:
 *   post:
 *     summary: Deactivate a supplier without active purchase orders
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Supplier deactivated and audited }
 *       409: { description: Version conflict or active purchase orders exist }
 */
router.post("/suppliers/:id/deactivate", authenticate, authorize(...govern), validate(procurementIdParamSchema, "params"), validate(deactivateSupplierSchema), deactivateSupplier);

/** @swagger
 * /procurement/purchase-orders:
 *   get:
 *     summary: List private purchase orders
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Private purchase-order list including commercial costs }
 *   post:
 *     summary: Create an idempotent draft purchase order
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Draft purchase order created }
 */
router.route("/purchase-orders")
  .get(authenticate, authorize(...manage), validate(purchaseOrderQuerySchema, "query"), listPurchaseOrders)
  .post(authenticate, authorize(...manage), validate(createPurchaseOrderSchema), createPurchaseOrder);
/** @swagger
 * /procurement/purchase-orders/{id}:
 *   get:
 *     summary: Get one private purchase order
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Private purchase-order detail }
 *       404: { description: Purchase order unavailable }
 */
router.get("/purchase-orders/:id", authenticate, authorize(...manage), validate(procurementIdParamSchema, "params"), getPurchaseOrder);
/** @swagger
 * /procurement/purchase-orders/{id}/submit:
 *   post:
 *     summary: Submit a draft purchase order for governance approval
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Purchase order submitted }
 * /procurement/purchase-orders/{id}/approve:
 *   post:
 *     summary: Approve a submitted purchase order
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Purchase order approved }
 *       403: { description: Governance role required }
 */
router.post("/purchase-orders/:id/submit", authenticate, authorize(...manage), validate(procurementIdParamSchema, "params"), submitPurchaseOrder);
router.post("/purchase-orders/:id/approve", authenticate, authorize(...govern), validate(procurementIdParamSchema, "params"), approvePurchaseOrder);
/** @swagger
 * /procurement/purchase-orders/{id}/cancel:
 *   post:
 *     summary: Cancel an unreceived purchase order with a reason
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Purchase order cancelled and audited }
 *       409: { description: Purchase order has receipts or is ineligible }
 * /procurement/purchase-orders/{id}/close:
 *   post:
 *     summary: Explicitly close a fully received purchase order
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Purchase order closed and audited }
 *       409: { description: Approved quantities remain outstanding }
 */
router.post("/purchase-orders/:id/cancel", authenticate, authorize(...govern), validate(procurementIdParamSchema, "params"), validate(purchaseOrderReasonSchema), cancelPurchaseOrder);
router.post("/purchase-orders/:id/close", authenticate, authorize(...govern), validate(procurementIdParamSchema, "params"), validate(purchaseOrderReasonSchema), closePurchaseOrder);
/** @swagger
 * /procurement/purchase-orders/{id}/receipts:
 *   post:
 *     summary: Receive an approved purchase-order line with retained evidence
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Receipt, unit or aggregate stock, ledger, and audit facts committed atomically }
 *       409: { description: Quantity, state, serial, or idempotency conflict }
 */
router.post("/purchase-orders/:id/receipts", authenticate, authorize(...manage), validate(procurementIdParamSchema, "params"), validate(receivePurchaseOrderSchema), receivePurchaseOrder);

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
 * /procurement/quotations/{id}/convert:
 *   post:
 *     summary: Convert an approved B2B quotation to an organisation order
 *     description: Active OWNER, ADMIN, or BUYER membership is resolved from server state. The approved, current, unexpired quotation is converted once in a transaction to an immutable order snapshot. Requires Idempotency-Key.
 *     tags: [Procurement]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Organisation order created }
 *       404: { description: Non-enumerating quotation or membership unavailable }
 *       409: { description: Expired, stale, inactive, idempotency-conflicting, or already-converted quotation }
 */
router.post(
  "/quotations/:id/convert",
  authenticate,
  customerMutationLimiter,
  validate(procurementQuotationIdParamSchema, "params"),
  validate(convertProcurementQuotationSchema, "body"),
  convertProcurementQuotation,
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
