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
    cost: { type: Number, required: true },
  }],
  total: {
    type: Number,
    required: true,
  },
  status: {
    type: String,
    enum: Object.values(QUOTE_STATUS),
    default: QUOTE_STATUS.DRAFT,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
}, { timestamps: true });

export default mongoose.model("Quote", QuoteSchema);
