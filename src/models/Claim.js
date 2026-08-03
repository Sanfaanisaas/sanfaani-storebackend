import mongoose from "mongoose";
import { CLAIM_STATUS } from "../utils/constants.js";

const { Schema } = mongoose;

const ClaimSchema = new Schema({
  warranty: {
    type: Schema.Types.ObjectId,
    ref: 'Warranty',
    required: true,
    index: true
  },
  repair: {
    type: Schema.Types.ObjectId,
    ref: 'Repair',
    required: true
  },
  submittedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  description: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: Object.values(CLAIM_STATUS),
    default: CLAIM_STATUS.SUBMITTED
  },
  resolutionNotes: {
    type: String
  }
}, { timestamps: true });

// Ensure resolutionNotes is not in the public shape
ClaimSchema.set('toJSON', {
  transform: (doc, ret, options) => {
    delete ret.resolutionNotes;
    return ret;
  }
});

export default mongoose.model("Claim", ClaimSchema);
