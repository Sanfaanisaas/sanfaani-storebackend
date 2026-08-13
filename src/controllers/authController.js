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

import {
  generateAccessToken,
  generateRefreshToken,
} from "../services/tokenService.js";

export const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email });
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Invalid credentials",
      errors: null,
    });
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    return res.status(401).json({
      success: false,
      message: "Invalid credentials",
      errors: null,
    });
  }

  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days, in milliseconds
  });

  res.status(200).json({
    success: true,
    data: {
      accessToken,
      user: user.toSafeObject(),
    },
  });
});

import { verifyRefreshToken } from "../services/tokenService.js";

export const refresh = catchAsync(async (req, res) => {
  const token = req.cookies.refreshToken;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "No refresh token provided",
      errors: null,
    });
  }

  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired refresh token",
      errors: null,
    });
  }

  const user = await User.findById(decoded.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User no longer exists",
      errors: null,
    });
  }

  const accessToken = generateAccessToken(user);

  res.status(200).json({
    success: true,
    data: { accessToken, user: user.toSafeObject() },
  });
});

export const logout = catchAsync(async (req, res) => {
  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });

  res.status(200).json({
    success: true,
    data: { message: "Logged out successfully" },
  });
});
