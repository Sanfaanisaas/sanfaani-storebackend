import mongoose from "mongoose";
const { Schema } = mongoose;

const WarrantySchema = new Schema({
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
