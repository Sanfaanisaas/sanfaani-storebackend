import express from "express";
import { initiatePayment, handleWebhook } from "../controllers/paymentController.js";
import { getPayment, requestRefund } from "../controllers/financeController.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { paymentLimiter, refundInitiationLimiter } from "../middleware/rateLimiter.js";
import { initiatePaymentSchema, paymentAttemptSchema } from "../utils/validators/paymentValidators.js";
import { paymentIdSchema, refundSchema } from "../utils/validators/financeValidators.js";
import { USER_ROLES } from "../utils/constants.js";

const router = express.Router();

/**
 * @swagger
 * /payments/webhook:
 *   post:
 *     summary: Receive a verified Paystack payment or refund callback
 *     description: The provider boundary verifies `X-Paystack-Signature` against the raw JSON body before parsing or transition work. Callback metadata is compared to persisted bindings and never overrides them.
 *     responses:
 *       200: { description: Callback accepted or safely reconciled }
 *       401: { description: Invalid provider signature }
 */
router.post("/webhook", handleWebhook);
router.post("/paystack/webhook", handleWebhook);

/**
 * @swagger
 * /payments/attempts:
 *   post:
 *     summary: Start a trusted payment attempt
 *     description: The authenticated owner supplies a subject reference and `Idempotency-Key`; the server derives amount, currency, owner, purpose, and repair quote version. Identical retries replay the same payment ID and conflicting key reuse returns 409.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 1, maxLength: 128 }
 *     responses:
 *       200: { description: Provider authorization URL and payment ID }
 *       400: { description: Invalid subject or transport input }
 *       409: { description: Conflicting idempotency key or unavailable amount }
 *       429: { description: Payment-attempt rate limit exceeded }
 *       502: { description: Controlled provider failure }
 */
router.post("/initiate", authenticate, paymentLimiter, validate(initiatePaymentSchema), initiatePayment);
router.post("/attempts", authenticate, paymentLimiter, validate(paymentAttemptSchema), initiatePayment);
router.get("/:paymentId", authenticate, validate(paymentIdSchema, "params"), getPayment);
/**
 * @swagger
 * /payments/{paymentId}/refunds:
 *   post:
 *     summary: Reserve a refund against a verified payment
 *     description: Finance officer, operations manager, or super administrator only. A transaction checks captured less refunded and reserved money, creates one standalone Refund record, and persists its audit record. It does not make an outbound refund request.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: paymentId
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema: { type: string, minLength: 1, maxLength: 128 }
 *     responses:
 *       202: { description: Financial refund reservation created }
 *       403: { description: Finance role required }
 *       409: { description: Conflicting idempotency key, unavailable balance, or invalid transition }
 *       429: { description: Refund initiation rate limit exceeded }
 */
router.post("/:paymentId/refunds", authenticate, authorize(USER_ROLES.FINANCE_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN), refundInitiationLimiter, validate(paymentIdSchema, "params"), validate(refundSchema), requestRefund);

export default router;
