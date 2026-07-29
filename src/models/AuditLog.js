import mongoose from "mongoose";
const { Schema } = mongoose;

const AuditLogSchema = new Schema({
  actor: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  action: {
    type: String,
    required: true,
    index: true,
  },
  targetType: {
    type: String,
    required: true,
  },
  targetId: {
    type: Schema.Types.ObjectId,
    required: true,
  },
  metadata: {
    type: Schema.Types.Mixed,
  },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Prevent updates or deletes
AuditLogSchema.pre('save', function(next) {
  if (!this.isNew) {
    return next(new Error('AuditLog entries are append-only.'));
  }
  next();
});

export default mongoose.model("AuditLog", AuditLogSchema);
