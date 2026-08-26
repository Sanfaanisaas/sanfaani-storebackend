import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { optionalAccessAuthentication } from "../middleware/optionalAuthenticate.js";
import { repairTrackingIssuanceLimiter, repairTrackingLimiter, repairTrackingRotationLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { 
  createRepairSchema, 
  getRepairsQuerySchema 
} from "../utils/validators/repairValidators.js";
import { 
  createRepair, 
  intakeRepair, 
  assignTechnician, 
  recordDiagnosis,
  createQuote,
  approveQuote,
  declineQuote,
  startRepair,
  completeRepairWork,
  addWorkLog,
  performQC,
  handoverRepair,
  trackRepair,
  rotateTrackingToken,
  getRepairQueue
} from "../controllers/repairController.js";
import { USER_ROLES } from "../utils/constants.js";

const router = Router();

/**
 * @swagger
 * /repairs:
 *   post:
 *     summary: Create a private repair request and issue its tracking token
 *     description: Authenticated customers only. Creation and first tracking-token issuance are transactional; the returned token is shown once and must be retained by the customer.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Private repair record and one raw tracking token }
 *       400: { description: Invalid intake request or missing privacy acknowledgement }
 *       401: { description: Authentication required }
 *       429: { description: Tracking-token issuance rate limit exceeded }
 */
router.post("/", authenticate, repairTrackingIssuanceLimiter, validate(createRepairSchema), createRepair);

router.patch(
  "/:id/intake",
  authenticate,
  authorize(USER_ROLES.STORE_OPERATOR, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  intakeRepair
);

router.patch(
  "/:id/assign-technician",
  authenticate,
  authorize(USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  assignTechnician
);

router.patch(
  "/:id/diagnosis",
  authenticate,
  authorize(USER_ROLES.TECHNICIAN),
  recordDiagnosis
);

/**
 * @swagger
 * /repairs/{id}/quote:
 *   post:
 *     summary: Send the next repair quote version
 *     description: Technician, operations manager, or super administrator only. Quote financial contents are immutable after creation; creating a new version supersedes the prior actionable version transactionally.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [lineItems]
 *             properties:
 *               lineItems:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [description, amount]
 *                   properties:
 *                     description: { type: string, maxLength: 500 }
 *                     amount: { type: integer, minimum: 0, description: Minor currency units }
 *     responses:
 *       201: { description: Sent immutable quote version }
 *       400: { description: Invalid quote input }
 *       403: { description: Forbidden role }
 *       404: { description: Unavailable repair }
 */
router.post(
  "/:id/quote",
  authenticate,
  authorize(USER_ROLES.TECHNICIAN, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  createQuote
);

/**
 * @swagger
 * /repairs/{id}/quote/{quoteId}/approve:
 *   patch:
 *     summary: Accept the current repair quote
 *     description: The owner may accept only the current, unexpired, customer-visible quote. A repeated identical decision is idempotent; a conflicting, superseded, expired, or declined decision is rejected without exposing a foreign quote.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: quoteId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Quote accepted }
 *       404: { description: Non-enumerating unavailable quote or repair }
 *       409: { description: Quote is no longer actionable or has a conflicting decision }
 */
router.patch(
  "/:id/quote/:quoteId/approve",
  authenticate,
  approveQuote
);

/**
 * @swagger
 * /repairs/{id}/quote/{quoteId}/decline:
 *   patch:
 *     summary: Decline the current repair quote
 *     description: Uses the same owner, latest-version, expiry, and non-enumeration rules as acceptance. Tracking tokens cannot invoke this route.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: quoteId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Quote declined }
 *       404: { description: Non-enumerating unavailable quote or repair }
 *       409: { description: Quote is no longer actionable or has a conflicting decision }
 */
router.patch("/:id/quote/:quoteId/decline", authenticate, declineQuote);

router.patch(
  "/:id/start",
  authenticate,
  authorize(USER_ROLES.TECHNICIAN, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  startRepair
);

router.patch(
  "/:id/complete",
  authenticate,
  authorize(USER_ROLES.TECHNICIAN),
  completeRepairWork
);

router.post(
  "/:id/log",
  authenticate,
  authorize(USER_ROLES.TECHNICIAN, USER_ROLES.QC_OFFICER, USER_ROLES.STORE_OPERATOR, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  addWorkLog
);

router.patch(
  "/:id/qc",
  authenticate,
  authorize(USER_ROLES.QC_OFFICER, USER_ROLES.SUPER_ADMIN),
  performQC
);

router.patch(
  "/:id/handover",
  authenticate,
  authorize(USER_ROLES.STORE_OPERATOR, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  handoverRepair
);

router.get(
  "/queue",
  authenticate,
  authorize(
    USER_ROLES.STORE_OPERATOR,
    USER_ROLES.TECHNICIAN,
    USER_ROLES.QC_OFFICER,
    USER_ROLES.SALES_ADVISOR,
    USER_ROLES.INVENTORY_OFFICER,
    USER_ROLES.FINANCE_OFFICER,
    USER_ROLES.SUPPORT_OFFICER,
    USER_ROLES.OPS_MANAGER,
    USER_ROLES.PRODUCT_ADMIN,
    USER_ROLES.TECH_ADMIN,
    USER_ROLES.SUPER_ADMIN
  ),
  validate(getRepairsQuerySchema, "query"),
  getRepairQueue
);

/**
 * @swagger
 * /repairs/{id}/track:
 *   get:
 *     summary: Read the safe status of one repair
 *     description: Requires either the owning customer's bearer token or a valid read-only `repair:track` token in `X-Repair-Tracking-Token`. A raw repair ID is never an authorization credential. Missing, invalid, expired, revoked, foreign, or unknown credentials all return the same 404 envelope.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: X-Repair-Tracking-Token
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Customer-safe repair tracking projection
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success: { type: boolean, const: true }
 *                 data: { $ref: '#/components/schemas/PublicRepairTracking' }
 *       404: { description: Non-enumerating unavailable tracking credential }
 *       429: { description: Tracking rate limit exceeded }
 */
router.get("/:id/track", repairTrackingLimiter, optionalAccessAuthentication, trackRepair);

/**
 * @swagger
 * /repairs/{id}/tracking-token:
 *   post:
 *     summary: Rotate a repair tracking token
 *     description: The authenticated repair owner only. Revokes every active token for the repair and returns the replacement raw token once. The database stores only an HMAC digest.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Replacement token returned once }
 *       404: { description: Non-enumerating unavailable repair }
 *       429: { description: Token rotation rate limit exceeded }
 */
router.post("/:id/tracking-token", authenticate, repairTrackingRotationLimiter, rotateTrackingToken);

export default router;
