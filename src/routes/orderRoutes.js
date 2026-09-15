import { Router } from "express";
import {
  getMyOrders,
  getOrderById,
  uploadReceipt,
  checkEligiblePickup,
  verifyBankTransfer,
  generateReceiptPDF,
  generateInvoicePDF,
  getOrderQueue,
  cancelOrder,
  dispatchOrder,
  collectOrder,
} from "../controllers/orderController.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  getOrdersQuerySchema,
  checkEligiblePickupSchema,
  getOrdersQueueQuerySchema,
} from "../utils/validators/orderValidators.js";
import {
  dispatchOrderSchema,
  collectOrderSchema,
} from "../utils/validators/orderValidators.js";
import { deliverOrder } from "../controllers/orderController.js";
import { USER_ROLES } from "../utils/constants.js";
import multer from "multer";
import { evidenceUploadLimiter } from "../middleware/rateLimiter.js";

// Disk is never an evidence store. Production upload persistence must be a private object-store adapter.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) =>
    callback(
      null,
      ["image/jpeg", "image/png", "application/pdf"].includes(file.mimetype),
    ),
});

const router = Router();

/**
 * @swagger
 * /orders/mine:
 *   get:
 *     summary: Get authenticated user's orders
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Orders retrieved successfully
 */
router.get(
  "/mine",
  authenticate,
  validate(getOrdersQuerySchema, "query"),
  getMyOrders,
);

/**
 * @swagger
 * /orders/{id}:
 *   get:
 *     summary: Get authenticated user's specific order
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Order retrieved successfully
 *       404:
 *         description: Order not found
 */
/**
 * @swagger
 * /orders/eligible-pickup:
 *   get:
 *     summary: Check persisted pay-on-pickup eligibility
 *     description: Requires an owner-scoped orderId. Amount, address, payment method, policy, and expiry are read from server state; client-supplied financial values are ignored.
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Eligibility status
 *       404:
 *         description: Non-enumerating unavailable owner order
 */
router.get(
  "/eligible-pickup",
  authenticate,
  validate(checkEligiblePickupSchema, "query"),
  checkEligiblePickup,
);

router.get("/:id/eligible-pickup", authenticate, checkEligiblePickup);

/**
 * @swagger
 * /orders/{id}/verify-bank-transfer:
 *   patch:
 *     summary: Verify bank transfer payment evidence
 *     description: Finance officer, operations manager, or super administrator only. Atomically settles the canonical Payment, updates the Order cache, allocates inventory, writes audits, and creates immutable invoice and receipt snapshots.
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Order verified successfully
 *       403:
 *         description: Finance or operations role required
 *       404:
 *         description: Order or active payment evidence unavailable
 */
router.patch(
  "/:id/verify-bank-transfer",
  authenticate,
  authorize(
    USER_ROLES.FINANCE_OFFICER,
    USER_ROLES.OPS_MANAGER,
    USER_ROLES.SUPER_ADMIN,
  ),
  verifyBankTransfer,
);

/**
 * @swagger
 * /orders/{id}/upload-receipt:
 *   post:
 *     summary: Upload private bank-transfer evidence
 *     description: Owner-only multipart upload. The object is stored privately, validated by file signature, linked to a server-derived pending Payment, and never marks the order paid.
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Evidence and pending canonical payment persisted
 *       404:
 *         description: Non-enumerating unavailable owner order
 */
router.post(
  "/:id/upload-receipt",
  authenticate,
  evidenceUploadLimiter,
  upload.single("receipt"),
  uploadReceipt,
);

/**
 * @swagger
 * /orders/{id}/receipt:
 *   get:
 *     summary: Download immutable verified-payment receipt PDF
 *     description: Owner-only. A receipt is available only after canonical payment verification and is rendered from an immutable snapshot rather than mutable Order state.
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: PDF receipt streamed
 */
router.get("/:id/receipt", authenticate, generateReceiptPDF);
/**
 * @swagger
 * /orders/{id}/invoice:
 *   get:
 *     summary: Download immutable order invoice PDF
 *     description: Owner-only and non-enumerating. The first successful request persists the immutable source snapshot used for every later rendering.
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Immutable invoice PDF }
 *       404: { description: Non-enumerating unavailable owner order }
 */
router.get("/:id/invoice", authenticate, generateInvoicePDF);

/**
 * @swagger
 * /orders/{id}/cancel:
 *   patch:
 *     summary: Cancel an unfulfilled order and release eligible inventory
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Idempotently cancelled order }
 *       404: { description: Non-enumerating unavailable customer order }
 *       409: { description: Fulfilled order cannot be cancelled }
 */
router.patch("/:id/cancel", authenticate, cancelOrder);

/**
 * @swagger
 * /orders/{id}/dispatch:
 *   patch:
 *     summary: Dispatch a paid, allocated order
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Order dispatched and allocation consumed }
 */
router.patch(
  "/:id/dispatch",
  authenticate,
  authorize(
    USER_ROLES.STORE_OPERATOR,
    USER_ROLES.OPS_MANAGER,
    USER_ROLES.SUPER_ADMIN,
  ),
  validate(dispatchOrderSchema, "body"),
  dispatchOrder,
);

/**
 * @swagger
 * /orders/{id}/collect:
 *   patch:
 *     summary: Complete collection of a paid, allocated order
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Order collection completed }
 */
router.patch(
  "/:id/collect",
  authenticate,
  authorize(
    USER_ROLES.STORE_OPERATOR,
    USER_ROLES.OPS_MANAGER,
    USER_ROLES.SUPER_ADMIN,
  ),
  validate(collectOrderSchema, "body"),
  collectOrder,
);

/**
 * @swagger
 * /orders/{id}/deliver:
 *   patch:
 *     summary: Confirm delivery of a dispatched order
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Order marked as completed/delivered }
 */
router.patch(
  "/:id/deliver",
  authenticate,
  authorize(
    USER_ROLES.STORE_OPERATOR,
    USER_ROLES.OPS_MANAGER,
    USER_ROLES.SUPER_ADMIN,
  ),
  deliverOrder,
);

router.get(
  "/queue",
  authenticate,
  authorize(
    USER_ROLES.STORE_OPERATOR,
    USER_ROLES.TECHNICIAN,
    USER_ROLES.QC_OFFICER,
    USER_ROLES.SALES_ADVISOR,
    USER_ROLES.INVENTORY_OFFICER,
    USER_ROLES.SUPPORT_OFFICER,
    USER_ROLES.FINANCE_OFFICER,
    USER_ROLES.MERCHANDISER,
    USER_ROLES.OPS_MANAGER,
    USER_ROLES.PRODUCT_ADMIN,
    USER_ROLES.TECH_ADMIN,
    USER_ROLES.SUPER_ADMIN,
  ),
  validate(getOrdersQueueQuerySchema, "query"),
  getOrderQueue,
);

// Keep parameter routes after every fixed path so values such as `queue` and
// `eligible-pickup` can never be captured as order identifiers.
router.get("/:id", authenticate, getOrderById);

export default router;
