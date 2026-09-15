import mongoose from "mongoose";
import { USER_ROLES } from "../utils/constants.js";

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true }, // e.g. "Home", "Office"
    street: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    country: { type: String, required: true, trim: true, default: "Nigeria" },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: Object.values(USER_ROLES),
      default: USER_ROLES.CUSTOMER,
    },
    status: {
      type: String,
      enum: ["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"],
      default: "ACTIVE",
      index: true,
    },
    authVersion: { type: Number, min: 0, default: 0, select: false },
    adminVersion: { type: Number, min: 0, default: 0 },
    mustChangePassword: { type: Boolean, default: false, select: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, select: false, immutable: true },
    roleChangedAt: { type: Date, default: null },
    statusChangedAt: { type: Date, default: null },
    statusReason: { type: String, trim: true, maxlength: 500, default: null, select: false },
    phone: {
      type: String,
      trim: true,
    },
    addresses: [addressSchema],
  },
  { timestamps: true }
);

userSchema.methods.toSafeObject = function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    phone: this.phone,
  };
};

const User = mongoose.model("User", userSchema);

export default User;
