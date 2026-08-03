import mongoose from "mongoose";
const { Schema } = mongoose;
import { QUOTE_STATUS } from "../utils/constants.js";

const QuoteSchema = new Schema({
  repair: {
    type: Schema.Types.ObjectId,
    ref: "Repair",
    required: true,
    index: true,
  },
  version: {
    type: Number,
    required: true,
  },
  lineItems: [{
    description: { type: String, required: true },
    amount: { type: Number, required: true },
  }],
  totalAmount: {
    type: Number,
    required: true,
  },
  estimatedDays: {
    type: Number,
    default: 3,
  },
  status: {
    type: String,
    enum: Object.values(QUOTE_STATUS),
    default: QUOTE_STATUS.PENDING,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
}, { timestamps: true });

export default mongoose.model("Quote", QuoteSchema);
