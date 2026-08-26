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
    default: QUOTE_STATUS.DRAFT,
  },
  isActionable: { type: Boolean, default: false, index: true },
  expiresAt: { type: Date, default: null },
  decision: {
    type: {
      type: String,
      enum: ["ACCEPTED", "DECLINED"],
      default: null,
    },
    decidedAt: { type: Date, default: null },
    actor: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorRole: { type: String, default: null },
    reason: { type: String, maxlength: 500, default: null },
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
}, { timestamps: true });

// Quote financial content becomes immutable as soon as it is sent. All
// lifecycle updates go through quoteService's conditional transition queries.
QuoteSchema.pre("save", function enforceFinancialImmutability() {
  if (!this.isNew && this.isModified("lineItems")) {
    throw new Error("Sent quote line items are immutable");
  }
  if (!this.isNew && this.isModified("totalAmount")) {
    throw new Error("Sent quote total is immutable");
  }
});

QuoteSchema.index({ repair: 1, version: 1 }, { unique: true, name: "unique_quote_version_per_repair" });
QuoteSchema.index(
  { repair: 1, isActionable: 1 },
  {
    unique: true,
    partialFilterExpression: { isActionable: true },
    name: "one_actionable_quote_per_repair",
  },
);

export default mongoose.model("Quote", QuoteSchema);
