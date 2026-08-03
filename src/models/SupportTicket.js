import mongoose from "mongoose";
import { SUPPORT_TICKET_STATUS } from "../utils/constants.js";

const { Schema } = mongoose;

const SupportTicketSchema = new Schema({
  customer: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  subject: {
    type: String,
    required: true
  },
  relatedOrder: {
    type: Schema.Types.ObjectId,
    ref: 'Order'
  },
  relatedRepair: {
    type: Schema.Types.ObjectId,
    ref: 'Repair'
  },
  status: {
    type: String,
    enum: Object.values(SUPPORT_TICKET_STATUS),
    default: SUPPORT_TICKET_STATUS.OPEN
  },
  messages: [{
    author: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    body: {
      type: String,
      required: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }]
}, { timestamps: true });

export default mongoose.model("SupportTicket", SupportTicketSchema);
