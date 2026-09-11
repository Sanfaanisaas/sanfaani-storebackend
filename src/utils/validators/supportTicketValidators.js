import { z } from "zod";
import { SUPPORT_TICKET_STATUS } from "../constants.js";

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Must be a valid 24-character hex ObjectId");

export const ticketIdParamSchema = z.object({
  id: objectIdSchema,
});

export const createSupportTicketSchema = z.object({
  subject: z.string().trim().min(3, "Subject must be at least 3 characters").max(200, "Subject cannot exceed 200 characters"),
  message: z.string().trim().min(5, "Message must be at least 5 characters").max(4000, "Message cannot exceed 4000 characters"),
  category: z.enum(["general", "order", "repair", "warranty", "claim", "return", "guidance", "procurement", "service"]).optional().default("general"),
  priority: z.enum(["normal", "high"]).optional().default("normal"),
  linkedResource: z.object({
    type: z.enum(["order", "repair", "warranty", "claim", "return", "guidance", "procurement_request", "service_request"]),
    id: objectIdSchema,
  }).optional().nullable(),
  relatedOrder: objectIdSchema.optional().nullable(),
  relatedRepair: objectIdSchema.optional().nullable(),
});

export const replySupportTicketSchema = z.object({
  body: z.string().trim().min(1, "Reply message body is required").max(4000, "Reply message cannot exceed 4000 characters"),
});

export const updateSupportTicketStatusSchema = z.object({
  status: z.enum(Object.values(SUPPORT_TICKET_STATUS), {
    errorMap: () => ({ message: "Invalid support ticket status" }),
  }),
  responseExpectation: z.string().trim().max(500).optional().nullable(),
  customerSafeSla: z.string().trim().max(500).optional().nullable(),
  nextAction: z.string().trim().max(500).optional().nullable(),
  resolutionSummary: z.string().trim().max(1500).optional().nullable(),
});

export const getSupportTicketsQuerySchema = z.object({
  page: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).default(1)).optional(),
  limit: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).max(50).default(20)).optional(),
});
