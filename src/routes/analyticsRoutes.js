import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { notificationLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { ingestAnalytics, getKpis } from "../controllers/analyticsController.js";
import { analyticsEventSchema, analyticsQuerySchema } from "../utils/validators/analyticsValidators.js";
import { USER_ROLES } from "../utils/constants.js";
const router = Router();
/**
 * @swagger
 * /analytics/events:
 *   post:
 *     summary: Record one consented, privacy-safe product analytics event
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       202: { description: Event accepted or consent declined }
 *       422: { description: Event, identity, or property schema is not allowlisted }
 * /analytics/kpis:
 *   get:
 *     summary: Read aggregate operational KPI event counts
 *     tags: [Analytics]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Aggregate, windowed KPI report }
 *       403: { description: Operations role required }
 */
router.post("/events", authenticate, notificationLimiter, validate(analyticsEventSchema, "body"), ingestAnalytics);
router.get("/kpis", authenticate, authorize(USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN), validate(analyticsQuerySchema, "query"), getKpis);
export default router;
