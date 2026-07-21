import { Router } from "express";
import { 
  getMyOrders, 
  uploadReceipt, 
  checkEligiblePickup, 
  generateReceiptPDF 
} from "../controllers/orderController.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { getOrdersQuerySchema } from "../utils/validators/orderValidators.js";
import multer from "multer";
import path from "path";
import fs from "fs";

// Configure multer for receipt uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "uploads/receipts";
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

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
router.get("/eligible-pickup", authenticate, checkEligiblePickup);

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
 *     summary: Generate PDF receipt (Admin only)
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: PDF receipt streamed
 */
router.get("/:id/receipt", authenticate, authorize("product_admin", "super_admin"), generateReceiptPDF);

export default router;
