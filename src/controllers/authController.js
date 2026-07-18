import bcrypt from "bcryptjs";
import User from "../models/User.js";
import { catchAsync } from "../utils/catchAsync.js";

export const register = catchAsync(async (req, res) => {
  const { name, email, password, phone } = req.body;

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(409).json({
      success: false,
      message: "An account with this email already exists",
      errors: null,
    });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await User.create({
    name,
    email,
    passwordHash,
    phone,
    // role is intentionally NOT taken from req.body
  });

  res.status(201).json({
    success: true,
    data: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
    },
  });
});