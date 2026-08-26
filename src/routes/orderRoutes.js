import { Router } from "express";
import { 
  getMyOrders, 
  uploadReceipt, 
  checkEligiblePickup, 
  verifyBankTransfer,
  generateReceiptPDF,
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
  getOrdersQueueQuerySchema
} from "../utils/validators/orderValidators.js";
import { USER_ROLES } from "../utils/constants.js";
import multer from "multer";

// Disk is never an evidence store. Production upload persistence must be a private object-store adapter.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => callback(null, ["image/jpeg", "image/png", "application/pdf"].includes(file.mimetype)),
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
router.get("/mine", authenticate, validate(getOrdersQuerySchema, "query"), getMyOrders);

/**
 * @swagger
 * /orders/eligible-pickup:
 *   get:
 *     summary: Check if order is eligible for pickup (Stub)
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Eligibility status
 */
router.get("/eligible-pickup", authenticate, validate(checkEligiblePickupSchema, "query"), checkEligiblePickup);

/**
 * @swagger
 * /orders/{id}/verify-bank-transfer:
 *   patch:
 *     summary: Verify bank transfer payment (Admin only)
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Order verified successfully
 */
router.patch("/:id/verify-bank-transfer", authenticate, authorize(USER_ROLES.PRODUCT_ADMIN, USER_ROLES.SUPER_ADMIN), verifyBankTransfer);

/**
 * @swagger
 * /orders/{id}/upload-receipt:
 *   post:
 *     summary: Upload manual payment receipt
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Receipt uploaded successfully
 */
router.post("/:id/upload-receipt", authenticate, upload.single("receipt"), uploadReceipt);

/**
 * @swagger
 * /orders/{id}/receipt:
 *   get:
 *     summary: Generate PDF receipt
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
 *     description: Store operator, operations manager, or super administrator only. Requires a verified paid order and allocated inventory; duplicate dispatch is idempotent.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Order dispatched and allocation consumed }
 *       403: { description: Fulfilment role required }
 *       409: { description: Payment or allocation gate failed }
 */
router.patch("/:id/dispatch", authenticate, authorize(USER_ROLES.STORE_OPERATOR, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN), dispatchOrder);
/**
 * @swagger
 * /orders/{id}/collect:
 *   patch:
 *     summary: Complete collection of a paid, allocated order
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Order collection completed }
 *       403: { description: Fulfilment role required }
 *       409: { description: Payment or allocation gate failed }
 */
router.patch("/:id/collect", authenticate, authorize(USER_ROLES.STORE_OPERATOR, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN), collectOrder);

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
    USER_ROLES.SUPER_ADMIN
  ),
  validate(getOrdersQueueQuerySchema, "query"),
  getOrderQueue
);

export default router;
