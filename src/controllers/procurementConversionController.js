import { catchAsync } from "../utils/catchAsync.js";
import { convertQuotationToOrder } from "../services/procurementConversionService.js";

export const convertProcurementQuotation = catchAsync(async (req, res) => {
  const result = await convertQuotationToOrder({
    actor: req.user.id,
    quotationId: req.params.id,
    input: req.body,
    idempotencyKey: req.get("Idempotency-Key"),
  });
  res.set("Idempotency-Replayed", String(result.replayed));
  res.status(result.replayed ? 200 : 201).json({ success: true, data: { order: result.order } });
});
