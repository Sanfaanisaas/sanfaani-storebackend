import { Router } from "express";
import {
  getCart,
  addItem,
  removeItem,
  mergeCart,
} from "../controllers/cartController.js";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  addItemSchema,
  mergeSchema,
} from "../utils/validators/cartValidators.js";

const router = Router();

// All cart routes require authentication
router.use(authenticate);

/**
 * @swagger
 * /cart:
 *   get:
 *     summary: Get current user's cart
 *     tags: [Cart]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cart retrieved successfully
 */
router.get("/", getCart);

/**
 * @swagger
 * /cart/items:
 *   post:
 *     summary: Add or update item in cart
 *     tags: [Cart]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [variantId, quantity]
 *             properties:
 *               variantId:
 *                 type: string
 *               quantity:
 *                 type: integer
 *                 minimum: 1
 *     responses:
 *       200:
 *         description: Item added/updated successfully
 *       400:
 *         description: Invalid input or out of stock
 */
router.post("/items", validate(addItemSchema), addItem);

/**
 * @swagger
 * /cart/items/{variantSku}:
 *   delete:
 *     summary: Remove item from cart
 *     tags: [Cart]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: variantSku
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Item removed successfully
 */
router.delete("/items/:variantSku", removeItem);

/**
 * @swagger
 * /cart/merge:
 *   post:
 *     summary: Merge guest items into logged-in user's cart
 *     tags: [Cart]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [guestItems]
 *             properties:
 *               guestItems:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [variantId, quantity]
 *                   properties:
 *                     variantId:
 *                       type: string
 *                     quantity:
 *                       type: integer
 *                       minimum: 1
 *     responses:
 *       200:
 *         description: Cart merged successfully
 *       400:
 *         description: Invalid input or out of stock
 */
router.post("/merge", validate(mergeSchema), mergeCart);

export default router;
