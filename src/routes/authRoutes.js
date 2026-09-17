import { Router } from "express";
import {
  listSessions, login, logout, refresh, register, revokeAllSessions, revokeSession,
} from "../controllers/authController.js";
import { authenticate } from "../middleware/authenticate.js";
import { optionalAccessAuthentication } from "../middleware/optionalAuthenticate.js";
import { protectCookieAuth } from "../middleware/csrfOrigin.js";
import { authLimiter, refreshLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { loginSchema, registerSchema, sessionParamsSchema } from "../utils/validators/authValidators.js";
import { acceptStaffInvitation } from "../controllers/staffIdentityController.js";
import { acceptStaffInvitationSchema } from "../utils/validators/staffIdentityValidators.js";

const router = Router();

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a customer account
 *     tags: [Auth]
 *     responses:
 *       201: { description: Account created }
 *       409: { description: Email is already registered }
 */
router.post("/register", authLimiter, validate(registerSchema), register);

/**
 * @swagger
 * /auth/staff-invitations/accept:
 *   post:
 *     summary: Activate an invited staff identity with a one-time opaque token
 *     tags: [StaffIdentity]
 *     parameters:
 *       - in: header
 *         name: X-Staff-Invitation-Token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Staff identity activated }
 *       404: { description: Invitation missing, invalid, expired, used, or revoked }
 */
router.post("/staff-invitations/accept", authLimiter, validate(acceptStaffInvitationSchema, "body"), acceptStaffInvitation);

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Issue a 15-minute bearer access token and create a refresh-cookie session
 *     tags: [Auth]
 *     responses:
 *       200: { description: Login successful; refresh token is set only as an HttpOnly cookie }
 *       401: { description: Invalid credentials }
 */
router.post("/login", protectCookieAuth, authLimiter, validate(loginSchema), login);

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Rotate the refresh cookie and issue a new access token
 *     description: Requires only the HttpOnly refresh cookie, not a bearer access token.
 *     tags: [Auth]
 *     responses:
 *       200: { description: Refresh token rotated and access token issued }
 *       401: { description: Missing, invalid, expired, revoked, or reused refresh token }
 *       403: { description: Browser Origin or Referer is not trusted }
 */
router.post("/refresh", protectCookieAuth, refreshLimiter, refresh);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Idempotently revoke the cookie session and clear its cookie
 *     tags: [Auth]
 *     responses:
 *       200: { description: Logout complete, including when the cookie was absent or invalid }
 */
router.post("/logout", protectCookieAuth, optionalAccessAuthentication, logout);

/**
 * @swagger
 * /auth/sessions:
 *   get:
 *     summary: List safe account-session metadata
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Sessions belonging to the authenticated account }
 *   delete:
 *     summary: Revoke all sessions belonging to the authenticated account
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Every account session was revoked }
 */
router.get("/sessions", authenticate, listSessions);
router.delete("/sessions", authenticate, revokeAllSessions);

/**
 * @swagger
 * /auth/sessions/{sessionId}:
 *   delete:
 *     summary: Revoke one session belonging to the authenticated account
 *     tags: [Auth]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Session revoked }
 *       404: { description: Session unavailable }
 */
router.delete("/sessions/:sessionId", authenticate, validate(sessionParamsSchema, "params"), revokeSession);

export default router;
