import mongoose from "mongoose";
const { Schema } = mongoose;
import { REPAIR_STATUS } from "../utils/constants.js";

const RepairSchema = new Schema({
  customer: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  device: {
    type: { type: String, required: true },
    brand: { type: String, required: true },
    model: { type: String, required: true },
    serialNumber: { type: String },
  },
  issueDescription: {
    type: String,
    required: true,
  },
  privacyAcknowledged: {
    type: Boolean,
    required: true,
  },
  status: {
    type: String,
    enum: Object.values(REPAIR_STATUS),
    default: REPAIR_STATUS.REQUESTED,
  },
  technician: {
    type: Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  intakePhotos: [String],
  intakeCondition: String,
  diagnosisNotes: String,
  estimatedCost: Number,
}, { timestamps: true });

RepairSchema.pre("validate", function () {
  if (this.privacyAcknowledged !== true) {
    this.invalidate("privacyAcknowledged", "Privacy acknowledgement is required to create a repair request.");
  }
});

export default mongoose.model("Repair", RepairSchema);
