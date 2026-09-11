import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { updateClaimStatus, getMyClaims, getClaimDetail } from "../controllers/claimController.js";
import { USER_ROLES } from "../utils/constants.js";
import { claimIdParamSchema, getClaimsQuerySchema, updateClaimStatusSchema } from "../utils/validators/claimValidators.js";

const router = Router();

/**
 * @swagger
 * /claims/mine:
 *   get:
 *     summary: List customer claims
 *     tags: [Claims]
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
 *         description: Owner claims list retrieved successfully
 */
router.get("/mine", authenticate, validate(getClaimsQuerySchema, "query"), getMyClaims);

/**
 * @swagger
 * /claims/{id}:
 *   get:
 *     summary: Get claim detail
 *     tags: [Claims]
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
 *         description: Owner-scoped claim projection
 *       404:
 *         description: Claim unavailable or not owned
 */
router.get("/:id", authenticate, validate(claimIdParamSchema, "params"), getClaimDetail);

/**
 * @swagger
 * /claims/{id}/status:
 *   patch:
 *     summary: Update claim status (Staff)
 *     tags: [Claims]
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
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *     responses:
 *       200:
 *         description: Claim status updated successfully
 *       403:
 *         description: Staff role required
 *       409:
 *         description: Invalid state transition or concurrent decision conflict
 */
router.patch(
  "/:id/status",
  authenticate,
  authorize(USER_ROLES.SUPPORT_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  validate(claimIdParamSchema, "params"),
  validate(updateClaimStatusSchema, "body"),
  updateClaimStatus
);

export default router;
