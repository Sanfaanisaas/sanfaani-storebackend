import { Router } from "express";
import {
  register,
  login,
  refresh,
  logout,
} from "../controllers/authController.js";
import { validate } from "../middleware/validate.js";
import {
  registerSchema,
  loginSchema,
} from "../utils/validators/authValidators.js";

const router = Router();

/**
 * @swagger
 * /auth/register:
 *   post:
 *     summary: Register a new customer account
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Test User
 *               email:
 *                 type: string
 *                 example: test@example.com
 *               password:
 *                 type: string
 *                 example: password123
 *               phone:
 *                 type: string
 *                 example: "09010172138"
 *     responses:
 *       201:
 *         description: User created successfully
 *       409:
 *         description: Email already exists
 */
router.post("/register", validate(registerSchema), register);

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: Log in and receive an access token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 example: test@example.com
 *               password:
 *                 type: string
 *                 example: password123
 *     responses:
 *       200:
 *         description: Login successful, returns access token and user profile
 *       401:
 *         description: Invalid credentials
 */
router.post("/login", validate(loginSchema), login);

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     summary: Get a new access token using the refresh token cookie
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: New access token issued
 *       401:
 *         description: Missing, invalid, or expired refresh token
 */
router.post("/refresh", refresh);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     summary: Log out and clear the refresh token cookie
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Logged out successfully
 */
router.post("/logout", logout);

export default router;
