import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { notificationLimiter } from "../middleware/rateLimiter.js";
import { getNotifications, getUnreadCount, markAllNotificationsRead, markNotificationRead, getNotificationPreferences, patchNotificationPreferences, getNotificationDeliveries } from "../controllers/notificationController.js";
import { getNotificationsQuerySchema, notificationIdParamSchema, updateNotificationPreferencesSchema } from "../utils/validators/notificationValidators.js";
import { USER_ROLES } from "../utils/constants.js";

const router = Router();

/**
 * @swagger
 * /notifications:
 *   get:
 *     summary: List customer notifications
 *     tags: [Notifications]
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
 *         description: Notifications list retrieved
 */
router.get("/", authenticate, notificationLimiter, validate(getNotificationsQuerySchema, "query"), getNotifications);

/**
 * @swagger
 * /notifications/unread-count:
 *   get:
 *     summary: Get unread notification count
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Unread notification count
 */
router.get("/unread-count", authenticate, notificationLimiter, getUnreadCount);
router.get("/deliveries", authenticate, authorize(USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN), notificationLimiter, getNotificationDeliveries);

/**
 * @swagger
 * /notifications/{id}/read:
 *   patch:
 *     summary: Mark notification as read
 *     tags: [Notifications]
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
 *         description: Notification marked read
 *       404:
 *         description: Notification unavailable
 */
router.patch("/:id/read", authenticate, notificationLimiter, validate(notificationIdParamSchema, "params"), markNotificationRead);

/**
 * @swagger
 * /notifications/read-all:
 *   post:
 *     summary: Mark all notifications as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: All notifications marked read
 */
router.post("/read-all", authenticate, notificationLimiter, markAllNotificationsRead);

export const preferencesRouter = Router();

/**
 * @swagger
 * /notification-preferences:
 *   get:
 *     summary: Get notification preferences
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Notification preferences retrieved
 */
preferencesRouter.get("/", authenticate, notificationLimiter, getNotificationPreferences);

/**
 * @swagger
 * /notification-preferences:
 *   patch:
 *     summary: Update notification preferences
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Notification preferences updated
 *       400:
 *         description: Validation failed (unknown category or non-boolean)
 */
preferencesRouter.patch("/", authenticate, notificationLimiter, validate(updateNotificationPreferencesSchema, "body"), patchNotificationPreferences);

export default router;
