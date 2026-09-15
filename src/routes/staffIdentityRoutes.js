import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { customerMutationLimiter } from "../middleware/rateLimiter.js";
import { USER_ROLES } from "../utils/constants.js";
import { changeStaffRole, inviteStaff, listStaff, listStaffRoles, reactivateStaff, rotateStaffInvitation, suspendStaff } from "../controllers/staffIdentityController.js";
import { changeStaffRoleSchema, changeStaffStatusSchema, inviteStaffSchema, staffIdParamsSchema, staffListQuerySchema } from "../utils/validators/staffIdentityValidators.js";

const router = Router();
const administrators = authorize(USER_ROLES.PRODUCT_ADMIN, USER_ROLES.SUPER_ADMIN);

/**
 * @swagger
 * /admin/staff/roles:
 *   get:
 *     summary: List the immutable application role-permission register
 *     tags: [StaffIdentity]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Explicit least-privilege role register }
 */
router.get("/roles", authenticate, administrators, listStaffRoles);

/**
 * @swagger
 * /admin/staff:
 *   get:
 *     summary: List staff accounts using a safe projection
 *     tags: [StaffIdentity]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Staff accounts }
 */
router.get("/", authenticate, administrators, validate(staffListQuerySchema, "query"), listStaff);

/**
 * @swagger
 * /admin/staff/invitations:
 *   post:
 *     summary: Invite a staff account and return its opaque activation token once
 *     tags: [StaffIdentity]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Staff invitation created }
 *       403: { description: Privileged role requires Super Administrator }
 */
router.post("/invitations", authenticate, administrators, customerMutationLimiter, validate(inviteStaffSchema, "body"), inviteStaff);

/**
 * @swagger
 * /admin/staff/{id}/invitations:
 *   post:
 *     summary: Revoke active invitation tokens and issue one replacement
 *     tags: [StaffIdentity]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Replacement token returned once }
 *       404: { description: Invited staff account unavailable }
 */
router.post("/:id/invitations", authenticate, administrators, customerMutationLimiter, validate(staffIdParamsSchema, "params"), rotateStaffInvitation);

/**
 * @swagger
 * /admin/staff/{id}/role:
 *   patch:
 *     summary: Change a staff role with optimistic concurrency
 *     tags: [StaffIdentity]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Role changed and sessions revoked }
 */
router.patch("/:id/role", authenticate, administrators, customerMutationLimiter, validate(staffIdParamsSchema, "params"), validate(changeStaffRoleSchema, "body"), changeStaffRole);

/**
 * @swagger
 * /admin/staff/{id}/suspend:
 *   post:
 *     summary: Suspend a staff identity and revoke every active session
 *     tags: [StaffIdentity]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Staff identity suspended }
 * /admin/staff/{id}/reactivate:
 *   post:
 *     summary: Reactivate a suspended staff identity without restoring sessions
 *     tags: [StaffIdentity]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Staff identity reactivated }
 */
router.post("/:id/suspend", authenticate, administrators, customerMutationLimiter, validate(staffIdParamsSchema, "params"), validate(changeStaffStatusSchema, "body"), suspendStaff);
router.post("/:id/reactivate", authenticate, administrators, customerMutationLimiter, validate(staffIdParamsSchema, "params"), validate(changeStaffStatusSchema, "body"), reactivateStaff);

export default router;
