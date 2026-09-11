import { Router } from "express";
import { optionalAccessAuthentication } from "../middleware/optionalAuthenticate.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { customerMutationLimiter } from "../middleware/rateLimiter.js";
import { createGuidance, resumeGuidance } from "../controllers/guidanceController.js";
import { catchAsync } from "../utils/catchAsync.js";
import { archiveGuidance, createGuidanceEscalation, getGuidanceEscalation, listOwnedGuidance, recordGuidanceAdvisorResponse } from "../services/guidanceService.js";
import { USER_ROLES } from "../utils/constants.js";
import { createGuidanceEscalationSchema, createGuidanceSchema, escalationIdParamSchema, getGuidanceQuerySchema, guidanceIdParamSchema, respondGuidanceEscalationSchema } from "../utils/validators/guidanceValidators.js";

const router = Router();

/**
 * @swagger
 * /guidance/mine:
 *   get:
 *     summary: List customer guidance sessions
 *     tags: [Guidance]
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
 *         description: Owner guidance sessions list
 */
router.get("/mine", authenticate, validate(getGuidanceQuerySchema, "query"), catchAsync(async (req, res) => res.json({ success: true, data: await listOwnedGuidance({ owner: req.user.id, query: req.query }) })));

/**
 * @swagger
 * /guidance:
 *   post:
 *     summary: Create a guidance session (Authenticated or Guest)
 *     tags: [Guidance]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       201:
 *         description: Guidance session created (guest gets X-Guidance-Resume-Token)
 */
router.post("/", optionalAccessAuthentication, customerMutationLimiter, validate(createGuidanceSchema, "body"), createGuidance);

/**
 * @swagger
 * /guidance/{id}/escalations/current:
 *   get:
 *     summary: Get active advisor escalation for guidance session
 *     tags: [Guidance]
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
 *         description: Active escalation or null
 */
router.get("/:id/escalations/current", authenticate, validate(guidanceIdParamSchema, "params"), catchAsync(async (req, res) => res.json({ success: true, data: await getGuidanceEscalation({ owner: req.user.id, id: req.params.id }) })));

/**
 * @swagger
 * /guidance/{id}/escalations:
 *   post:
 *     summary: Request sales advisor escalation
 *     tags: [Guidance]
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
 *             required: [question]
 *     responses:
 *       201:
 *         description: Advisor escalation created
 *       409:
 *         description: Active escalation already exists
 */
router.post(
  "/:id/escalations",
  authenticate,
  customerMutationLimiter,
  validate(guidanceIdParamSchema, "params"),
  validate(createGuidanceEscalationSchema, "body"),
  catchAsync(async (req, res) => res.status(201).json({ success: true, data: await createGuidanceEscalation({ owner: req.user.id, id: req.params.id, question: req.body.question }) }))
);

/**
 * @swagger
 * /guidance/{id}/archive:
 *   patch:
 *     summary: Archive guidance session
 *     tags: [Guidance]
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
 *         description: Guidance session archived
 */
router.patch("/:id/archive", authenticate, customerMutationLimiter, validate(guidanceIdParamSchema, "params"), catchAsync(async (req, res) => res.json({ success: true, data: await archiveGuidance({ owner: req.user.id, id: req.params.id }) })));

/**
 * @swagger
 * /guidance/escalations/{id}/respond:
 *   post:
 *     summary: Respond to guidance escalation (Advisor/Staff)
 *     tags: [Guidance]
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
 *             required: [response]
 *     responses:
 *       200:
 *         description: Advisor response recorded
 *       403:
 *         description: Advisor staff role required
 */
router.post(
  "/escalations/:id/respond",
  authenticate,
  authorize(USER_ROLES.SALES_ADVISOR, USER_ROLES.SUPPORT_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  validate(escalationIdParamSchema, "params"),
  validate(respondGuidanceEscalationSchema, "body"),
  catchAsync(async (req, res) => res.json({ success: true, data: await recordGuidanceAdvisorResponse({ advisor: req.user.id, id: req.params.id, response: req.body.response, displayName: req.body.displayName || null }) }))
);

/**
 * @swagger
 * /guidance/{id}:
 *   get:
 *     summary: Resume guidance session (via Bearer token or X-Guidance-Resume-Token header)
 *     tags: [Guidance]
 *     security:
 *       - bearerAuth: []
 *       - guidanceResumeToken: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: header
 *         name: X-Guidance-Resume-Token
 *         required: false
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Guidance session detail
 *       404:
 *         description: Guidance session unavailable or invalid resume token
 */
router.get("/:id", optionalAccessAuthentication, validate(guidanceIdParamSchema, "params"), resumeGuidance);

export default router;
