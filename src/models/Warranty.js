import mongoose from "mongoose";
const { Schema } = mongoose;

const WarrantySchema = new Schema({
  order: { type: Schema.Types.ObjectId, ref: "Order", default: null },
  orderItemSku: { type: String, default: null, maxlength: 128 },
  repair: { 
    type: Schema.Types.ObjectId, 
    ref: 'Repair', 
    required: true 
  },
  customer: { 
    type: Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  deviceSummary: { 
    type: String, 
    required: true 
  },
  policyVersion: { type: String, default: "2024-01-01", maxlength: 64 },
  policySnapshot: { coverage: { type: String, default: "Standard repair workmanship coverage", maxlength: 1000 }, exclusions: { type: [String], default: [] } },
  issuedAt: { 
    type: Date, 
    default: Date.now 
  },
  expiresAt: { 
    type: Date, 
    required: true 
  }
}, { timestamps: true });

export default mongoose.model("Warranty", WarrantySchema);
