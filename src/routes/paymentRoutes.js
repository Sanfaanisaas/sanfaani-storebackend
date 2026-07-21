import express from "express";
import { initiatePayment, handleWebhook } from "../controllers/paymentController.js";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { initiatePaymentSchema } from "../utils/validators/paymentValidators.js";

const router = express.Router();

// Webhook handling is already partially handled in server.js with express.raw
// but we still need the controller to be mounted at the right path.
router.post("/webhook", handleWebhook);

router.post("/initiate", authenticate, validate(initiatePaymentSchema), initiatePayment);

export default router;
