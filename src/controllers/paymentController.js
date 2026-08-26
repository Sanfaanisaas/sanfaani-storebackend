import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import { getPaystackProvider } from "../services/paystackProvider.js";
import { createPaymentAttempt, processVerifiedPaymentEvent } from "../services/paymentTransitionService.js";

const normalizedWebhook = (event) => {
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  return {
    providerReference: typeof data.reference === "string" ? data.reference : "",
    providerEventId: data.id === undefined || data.id === null ? "" : String(data.id),
    eventType: typeof event?.event === "string" ? event.event : "unknown",
    normalized: {
      amount: Number.isSafeInteger(data.amount) ? data.amount : null,
      currency: typeof data.currency === "string" ? data.currency : null,
      paidAt: data.paid_at ? new Date(data.paid_at) : null,
      metadata: {
        subjectType: metadata.subjectType,
        subjectId: metadata.subjectId,
        owner: metadata.owner,
        purpose: metadata.purpose,
        quoteVersion: metadata.quoteVersion,
      },
    },
  };
};

export const initiatePayment = catchAsync(async (req, res) => {
  const subjectType = req.body.subjectType || "order";
  const subjectId = req.body.subjectId || req.body.orderId;
  const idempotencyKey = req.get("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length > 128) throw new AppError("Idempotency-Key is required", 400);
  const attempt = await createPaymentAttempt({ subjectType, subjectId, owner: req.user.id, idempotencyKey, purpose: req.body.purpose });
  const payment = attempt.payment;
  if (attempt.replayed) res.set("Idempotency-Replayed", "true");
  const response = await getPaystackProvider().initializePayment({
    email: req.body.email,
    amount: payment.amount,
    reference: payment.providerReference,
    metadata: {
      subjectId: payment.subjectId.toString(), subjectType: payment.subjectType,
      owner: payment.owner.toString(), purpose: payment.purpose,
      quoteVersion: payment.quoteVersion, paymentId: payment._id.toString(),
    },
  });
  res.status(200).json({ status: "success", data: { authorizationUrl: response.authorizationUrl, paymentId: payment._id } });
});

export const handleWebhook = catchAsync(async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  if (!getPaystackProvider().verifyWebhookSignature(req.body, signature)) {
    throw new AppError("Webhook signature is invalid", 401, [{ code: "webhook_signature_invalid", message: "The payment callback could not be verified" }]);
  }
  const event = JSON.parse(req.body.toString());
  if (event?.event === "charge.success") {
    const callback = normalizedWebhook(event);
    await processVerifiedPaymentEvent({ provider: "paystack", providerReference: callback.providerReference, providerEventId: callback.providerEventId, eventType: callback.eventType, normalized: callback.normalized, rawBody: req.body });
  }
  return res.sendStatus(200);
});
