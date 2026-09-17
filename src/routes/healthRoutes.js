import { Router } from "express";
import { readiness } from "../services/readinessService.js";

const router = Router();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Check API health status
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: API is running
 */
router.get("/health", (req, res) => {
  res.status(200).json({ success: true, data: { status: "ok" } });
});

/**
 * @swagger
 * /ready:
 *   get:
 *     summary: Check required dependency readiness without exposing secrets
 *     tags: [Health]
 *     responses:
 *       200: { description: Application is ready for traffic }
 *       503: { description: A required dependency is unavailable }
 */
router.get("/ready", (req, res) => {
  const state = readiness();
  return res.status(state.ready ? 200 : 503).json({ success: state.ready, data: state.dependencies });
});

export default router;
