import { Router } from "express";
import { getMyOrders } from "../controllers/orderController.js";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { getOrdersQuerySchema } from "../utils/validators/orderValidators.js";

const router = Router();

/**
 * @swagger
 * /orders/mine:
 *   get:
 *     summary: Get authenticated user's orders
 *     tags: [Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Number of orders per page
 *     responses:
 *       200:
 *         description: Orders retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     orders:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Order'
 *                     totalCount:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *       401:
 *         description: Unauthorized
 */
router.get("/mine", authenticate, validate(getOrdersQuerySchema, "query"), getMyOrders);

export default router;
