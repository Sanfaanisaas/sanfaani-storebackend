import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { customerMutationLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import {
  addOrUpdateOrganisationMember,
  createOrganisation,
  listMyOrganisations,
  listOrganisationMembers,
} from "../controllers/organisationController.js";
import {
  createOrganisationSchema,
  organisationIdParamSchema,
  organisationMemberSchema,
} from "../utils/validators/organisationValidators.js";

const router = Router();

/**
 * @swagger
 * /organisations:
 *   post:
 *     summary: Create an organisation and owner membership
 *     description: Atomically creates an active organisation and grants its authenticated creator OWNER purchasing authority. Requires Idempotency-Key.
 *     tags: [Organisations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Organisation created }
 *       409: { description: Idempotency conflict }
 */
router.post("/", authenticate, customerMutationLimiter, validate(createOrganisationSchema), createOrganisation);

/**
 * @swagger
 * /organisations/mine:
 *   get:
 *     summary: List active organisation memberships
 *     tags: [Organisations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Active memberships and organisation summaries }
 */
router.get("/mine", authenticate, listMyOrganisations);

/**
 * @swagger
 * /organisations/{id}/members:
 *   get:
 *     summary: List organisation members
 *     tags: [Organisations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Membership list }
 *       404: { description: Organisation unavailable to caller }
 *   post:
 *     summary: Add or update an organisation member
 *     description: OWNER or ADMIN only. Purchasing authority is derived from the persisted membership role, never an access-token role claim.
 *     tags: [Organisations]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Membership persisted }
 *       404: { description: Organisation unavailable to caller }
 */
router.get("/:id/members", authenticate, validate(organisationIdParamSchema, "params"), listOrganisationMembers);
router.post("/:id/members", authenticate, customerMutationLimiter, validate(organisationIdParamSchema, "params"), validate(organisationMemberSchema), addOrUpdateOrganisationMember);

export default router;
