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

// Webhook handling is already partially handled in server.js with express.raw
// but we still need the controller to be mounted at the right path.
router.post("/webhook", handleWebhook);
router.post("/paystack/webhook", handleWebhook);

router.post("/initiate", authenticate, paymentLimiter, validate(initiatePaymentSchema), initiatePayment);
router.post("/attempts", authenticate, paymentLimiter, validate(paymentAttemptSchema), initiatePayment);
router.get("/:paymentId", authenticate, validate(paymentIdSchema, "params"), getPayment);
router.post("/:paymentId/refunds", authenticate, authorize(USER_ROLES.FINANCE_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN), refundInitiationLimiter, validate(paymentIdSchema, "params"), validate(refundSchema), requestRefund);

export default router;
