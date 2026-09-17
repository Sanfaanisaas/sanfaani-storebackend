import { catchAsync } from "../utils/catchAsync.js";
import { ingestAnalyticsEvent, kpiReport } from "../services/analyticsService.js";
export const ingestAnalytics = catchAsync(async (req, res) => res.status(202).json({ success: true, data: await ingestAnalyticsEvent({ subject: req.user?.id, input: req.body, idempotencyKey: req.get("Idempotency-Key") }) }));
export const getKpis = catchAsync(async (req, res) => res.json({ success: true, data: await kpiReport(req.query) }));
