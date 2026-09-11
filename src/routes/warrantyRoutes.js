import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { customerMutationLimiter } from "../middleware/rateLimiter.js";
import { createClaim } from "../controllers/claimController.js";
import { getMyWarranties, getWarrantyDetail, getWarrantyEligibility } from "../controllers/warrantyController.js";
import { warrantyIdParamSchema, getWarrantiesQuerySchema } from "../utils/validators/warrantyValidators.js";
import { createClaimSchema } from "../utils/validators/claimValidators.js";

const router = Router();

/**
 * @swagger
 * /warranties/mine:
 *   get:
 *     summary: List customer warranties
 *     tags: [Warranties]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Bounded owner warranties retrieved successfully
 *       401:
 *         description: Authentication required
 */
router.get("/mine", authenticate, validate(getWarrantiesQuerySchema, "query"), getMyWarranties);

/**
 * @swagger
 * /warranties/{id}/eligibility:
 *   get:
 *     summary: Check warranty claim eligibility
 *     tags: [Warranties]
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
 *         description: Derived server-side claim eligibility status
 *       404:
 *         description: Warranty unavailable or not owned
 */
router.get("/:id/eligibility", authenticate, validate(warrantyIdParamSchema, "params"), getWarrantyEligibility);

/**
 * @swagger
 * /warranties/{id}:
 *   get:
 *     summary: Get warranty detail
 *     tags: [Warranties]
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
 *         description: Owner-scoped warranty projection
 *       404:
 *         description: Warranty unavailable or not owned
 */
router.get("/:id", authenticate, validate(warrantyIdParamSchema, "params"), getWarrantyDetail);

/**
 * @swagger
 * /warranties/{id}/claims:
 *   post:
 *     summary: File a warranty claim
 *     tags: [Warranties, Claims]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *             required: [description]
 *             properties:
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Claim submitted successfully
 *       400:
 *         description: Validation failed
 *       409:
 *         description: Warranty ineligible or active claim exists
 */
router.post("/:id/claims", authenticate, customerMutationLimiter, validate(warrantyIdParamSchema, "params"), validate(createClaimSchema, "body"), createClaim);

export default router;
