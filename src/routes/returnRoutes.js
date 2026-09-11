import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { USER_ROLES } from "../utils/constants.js";
import { customerMutationLimiter } from "../middleware/rateLimiter.js";
import { createReturn, listMyReturns, decideReturn, getReturnDetail, getReturnEligibility } from "../controllers/returnController.js";
import { createReturnSchema, decideReturnSchema, getReturnsQuerySchema, returnIdParamSchema, returnOrderIdParamSchema } from "../utils/validators/returnValidators.js";

const router = Router();

/**
 * @swagger
 * /returns/orders/{orderId}/eligibility:
 *   get:
 *     summary: Check order return eligibility
 *     tags: [Returns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Derived server-side return eligibility status and eligible quantities
 *       404:
 *         description: Order unavailable or not owned
 */
router.get("/orders/:orderId/eligibility", authenticate, validate(returnOrderIdParamSchema, "params"), getReturnEligibility);

/**
 * @swagger
 * /returns/orders/{orderId}:
 *   post:
 *     summary: Submit a return request
 *     tags: [Returns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: orderId
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
 *             required: [items, reason]
 *     responses:
 *       201:
 *         description: Return request created successfully
 *       400:
 *         description: Validation failed
 *       409:
 *         description: Order ineligible or item quantity limit exceeded
 */
router.post(
  "/orders/:orderId",
  authenticate,
  customerMutationLimiter,
  validate(returnOrderIdParamSchema, "params"),
  validate(createReturnSchema, "body"),
  createReturn
);

/**
 * @swagger
 * /returns/mine:
 *   get:
 *     summary: List customer returns
 *     tags: [Returns]
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
 *         description: Owner return requests list
 */
router.get("/mine", authenticate, validate(getReturnsQuerySchema, "query"), listMyReturns);

/**
 * @swagger
 * /returns/{id}:
 *   get:
 *     summary: Get return detail
 *     tags: [Returns]
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
 *         description: Owner return request detail
 *       404:
 *         description: Return request unavailable or not owned
 */
router.get("/:id", authenticate, validate(returnIdParamSchema, "params"), getReturnDetail);

/**
 * @swagger
 * /returns/{id}/decision:
 *   patch:
 *     summary: Record staff return decision
 *     tags: [Returns]
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
 *             required: [status]
 *     responses:
 *       200:
 *         description: Return decision recorded
 *       403:
 *         description: Staff role required
 *       409:
 *         description: Invalid state transition or concurrent decision conflict
 */
router.patch(
  "/:id/decision",
  authenticate,
  authorize(USER_ROLES.SUPPORT_OFFICER, USER_ROLES.FINANCE_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  validate(returnIdParamSchema, "params"),
  validate(decideReturnSchema, "body"),
  decideReturn
);

export default router;
