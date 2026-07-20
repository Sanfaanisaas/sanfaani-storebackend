import { Router } from "express";

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

export default router;
