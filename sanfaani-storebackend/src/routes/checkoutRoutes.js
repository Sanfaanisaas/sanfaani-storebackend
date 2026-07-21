import { Router } from "express";
import { createCheckout } from "../controllers/checkoutController.js";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { checkoutSchema } from "../utils/validators/checkoutValidators.js";

const router = Router();

/**
 * @swagger
 * /checkout:
 *   post:
 *     summary: Create a new order and checkout
 *     tags: [Checkout]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items, shippingAddress, paymentMethod]
 *             properties:
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [variantId, price, quantity]
 *                   properties:
 *                     variantId:
 *                       type: string
 *                     price:
 *                       type: number
 *                     quantity:
 *                       type: integer
 *               shippingAddress:
 *                 type: object
 *                 required: [street, city, state, country]
 *                 properties:
 *                   street:
 *                     type: string
 *                   city:
 *                     type: string
 *                   state:
 *                     type: string
 *                   postalCode:
 *                     type: string
 *                   country:
 *                     type: string
 *               paymentMethod:
 *                 type: string
 *                 enum: [paystack, bank_transfer, pay_on_pickup]
 *     responses:
 *       201:
 *         description: Order created successfully
 *       400:
 *         description: Invalid input or checkout failed
 */
router.post("/", authenticate, validate(checkoutSchema), createCheckout);

export default router;
