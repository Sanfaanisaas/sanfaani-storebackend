import { Router } from "express";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { customerMutationLimiter } from "../middleware/rateLimiter.js";
import { createSupportTicket, replyToTicket, updateTicketStatus, getMyTickets, getTicketDetail } from "../controllers/supportTicketController.js";
import { USER_ROLES } from "../utils/constants.js";
import { createSupportTicketSchema, getSupportTicketsQuerySchema, replySupportTicketSchema, ticketIdParamSchema, updateSupportTicketStatusSchema } from "../utils/validators/supportTicketValidators.js";

const router = Router();

/**
 * @swagger
 * /support-tickets/mine:
 *   get:
 *     summary: List customer support tickets
 *     tags: [SupportTickets]
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
 *         description: Owner support tickets list
 */
router.get("/mine", authenticate, validate(getSupportTicketsQuerySchema, "query"), getMyTickets);

/**
 * @swagger
 * /support-tickets:
 *   post:
 *     summary: Create a support ticket
 *     tags: [SupportTickets]
 *     security:
 *       - bearerAuth: []
 *     parameters:
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
 *             required: [subject, message]
 *     responses:
 *       201:
 *         description: Support ticket created successfully
 *       400:
 *         description: Validation failed
 *       409:
 *         description: Idempotency fingerprint conflict
 */
router.post("/", authenticate, customerMutationLimiter, validate(createSupportTicketSchema, "body"), createSupportTicket);

/**
 * @swagger
 * /support-tickets/{id}:
 *   get:
 *     summary: Get support ticket detail
 *     tags: [SupportTickets]
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
 *         description: Owner support ticket detail
 *       404:
 *         description: Ticket unavailable or not owned
 */
router.get("/:id", authenticate, validate(ticketIdParamSchema, "params"), getTicketDetail);

/**
 * @swagger
 * /support-tickets/{id}/reply:
 *   post:
 *     summary: Reply to a support ticket
 *     tags: [SupportTickets]
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
 *             required: [body]
 *     responses:
 *       201:
 *         description: Reply recorded successfully
 *       409:
 *         description: Ticket closed or unavailable for replies
 */
router.post("/:id/reply", authenticate, customerMutationLimiter, validate(ticketIdParamSchema, "params"), validate(replySupportTicketSchema, "body"), replyToTicket);

/**
 * @swagger
 * /support-tickets/{id}/status:
 *   patch:
 *     summary: Update support ticket status (Staff)
 *     tags: [SupportTickets]
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
 *     responses:
 *       200:
 *         description: Ticket status updated
 *       403:
 *         description: Staff role required
 */
router.patch(
  "/:id/status",
  authenticate,
  authorize(USER_ROLES.SUPPORT_OFFICER, USER_ROLES.OPS_MANAGER, USER_ROLES.SUPER_ADMIN),
  validate(ticketIdParamSchema, "params"),
  validate(updateSupportTicketStatusSchema, "body"),
  updateTicketStatus
);

export default router;
