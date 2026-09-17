import mongoose from "mongoose";

export const ORGANISATION_MEMBER_ROLES = Object.freeze(["OWNER", "ADMIN", "BUYER", "VIEWER"]);
export const ORGANISATION_MEMBER_STATUSES = Object.freeze(["ACTIVE", "REVOKED"]);

const schema = new mongoose.Schema({
  organisation: { type: mongoose.Schema.Types.ObjectId, ref: "Organisation", required: true, immutable: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
  role: { type: String, enum: ORGANISATION_MEMBER_ROLES, required: true },
  status: { type: String, enum: ORGANISATION_MEMBER_STATUSES, default: "ACTIVE", index: true },
  canPurchase: { type: Boolean, required: true, default: false },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  revokedAt: { type: Date, default: null },
}, { timestamps: true });

schema.index({ organisation: 1, user: 1 }, { unique: true, name: "one_membership_per_organisation_user" });
schema.index({ user: 1, status: 1, updatedAt: -1 }, { name: "active_organisation_memberships" });

export default mongoose.model("OrganisationMember", schema);
