import mongoose from "mongoose";
import { SUPPORT_TICKET_STATUS } from "../utils/constants.js";
const { Schema } = mongoose;

const messageSchema = new Schema({
  author: { type: Schema.Types.ObjectId, ref: "User", required: true },
  authorType: { type: String, enum: ["customer", "support"], required: true },
  body: { type: String, required: true, trim: true, maxlength: 4000 },
  idempotencyKey: { type: String, trim: true, maxlength: 128, default: null },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const SupportTicketSchema = new Schema({
  customer: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  subject: { type: String, required: true, trim: true, minlength: 3, maxlength: 200 },
  category: { type: String, enum: ["general", "order", "repair", "warranty", "claim", "return", "guidance", "procurement", "service"], default: "general" },
  priority: { type: String, enum: ["normal", "high"], default: "normal" },
  relatedOrder: { type: Schema.Types.ObjectId, ref: "Order", default: null },
  relatedRepair: { type: Schema.Types.ObjectId, ref: "Repair", default: null },
  linkedResource: { type: { type: String, enum: ["order", "repair", "warranty", "claim", "return", "guidance", "procurement_request", "service_request"], default: null }, id: { type: Schema.Types.ObjectId, default: null } },
  status: { type: String, enum: Object.values(SUPPORT_TICKET_STATUS), default: SUPPORT_TICKET_STATUS.OPEN, index: true },
  responseExpectation: { type: String, trim: true, maxlength: 500, default: null },
  customerSafeSla: { type: String, trim: true, maxlength: 500, default: null },
  nextAction: { type: String, trim: true, maxlength: 500, default: null },
  resolutionSummary: { type: String, trim: true, maxlength: 1500, default: null },
  messages: { type: [messageSchema], default: [] },
  idempotencyKey: { type: String, trim: true, minlength: 1, maxlength: 128, immutable: true },
  idempotencyFingerprint: { type: String, match: /^[a-f0-9]{64}$/, immutable: true },
  privateNotes: { type: String, select: false, maxlength: 4000, default: null },
}, { timestamps: true });

SupportTicketSchema.index({ customer: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } }, name: "customer_support_ticket_idempotency" });
SupportTicketSchema.index({ customer: 1, updatedAt: -1 }, { name: "customer_support_ticket_list" });
export default mongoose.model("SupportTicket", SupportTicketSchema);
