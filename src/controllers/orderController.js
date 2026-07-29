import Order from "../models/Order.js";
import { ORDER_STATUS } from "../utils/constants.js";
import { isPayOnPickupEligible } from "../services/orderService.js";
import { catchAsync } from "../utils/catchAsync.js";
import pdfkit from "pdfkit";
import fs from "fs";
import path from "path";

/**
 * Get authenticated user's orders with pagination
 */
export const getMyOrders = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const skip = (page - 1) * limit;

  const query = { userId: req.user.id };

  const [orders, totalCount] = await Promise.all([
    Order.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Order.countDocuments(query),
  ]);

  const publicOrders = orders.map((order) => order.toPublicOrder());

  res.status(200).json({
    success: true,
    data: {
      orders: publicOrders,
      totalCount,
      page,
      totalPages: Math.ceil(totalCount / limit),
    },
  });
});

/**
 * Upload manual payment receipt
 */
export const uploadReceipt = catchAsync(async (req, res) => {
  const { id } = req.params;
  const order = await Order.findOne({ _id: id, userId: req.user.id });

  if (!order) {
    return res.status(404).json({
      success: false,
      message: "Order not found",
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "Please upload a receipt file",
    });
  }

  // Store the relative path or full URL. For now, we use the filename.
  order.receiptUrl = `/uploads/receipts/${req.file.filename}`;
  order.paymentMethod = "bank_transfer";
  await order.save();

  res.status(200).json({
    success: true,
    data: order.toPublicOrder(),
  });
});

/**
 * Check if order is eligible for pickup
 */
export const checkEligiblePickup = catchAsync(async (req, res) => {
  const { total, shippingAddress } = req.query;

  const orderData = {
    total,
    shippingAddress
  };

  const eligible = isPayOnPickupEligible(orderData);

  res.status(200).json({
    success: true,
    data: {
      eligible,
      message: eligible 
        ? "Order is eligible for pay-on-pickup." 
        : "Order is not eligible for pay-on-pickup based on location or total amount.",
    },
  });
});

/**
 * Verify bank transfer payment (Admin only)
 */
export const verifyBankTransfer = catchAsync(async (req, res) => {
  const { id } = req.params;

  const order = await Order.findOneAndUpdate(
    { 
      _id: id, 
      paymentMethod: 'bank_transfer', 
      paymentStatus: 'pending' 
    },
    { 
      paymentStatus: 'paid', 
      verifiedBy: req.user.id, 
      verifiedAt: new Date(),
      status: ORDER_STATUS.PAID
    },
    { new: true }
  );

  if (!order) {
    return res.status(400).json({
      success: false,
      message: "Order not eligible for verification (not found, already paid, or not bank transfer)",
    });
  }

  res.status(200).json({
    success: true,
    data: order.toPublicOrder(),
  });
});

/**
 * Generate and stream PDF receipt
 */
export const generateReceiptPDF = catchAsync(async (req, res) => {
  const { id } = req.params;
  const order = await Order.findById(id).populate("userId", "email");

  if (!order) {
    return res.status(404).json({
      success: false,
      message: "Order not found",
    });
  }

  // Allow access if user is the owner OR is an admin/authorized role
  const isOwner = order.userId._id.toString() === req.user.id.toString();
  const isAdmin = ["product_admin", "super_admin"].includes(req.user.role);

  if (!isOwner && !isAdmin) {
    return res.status(403).json({
      success: false,
      message: "You do not have permission to access this receipt",
    });
  }

  const doc = new pdfkit();
  const filename = `receipt_${order._id}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

  doc.pipe(res);

  // PDF Content
  doc.fontSize(20).text("Order Receipt", { align: "center" });
  doc.moveDown();
  doc.fontSize(12).text(`Order ID: ${order._id}`);
  doc.text(`Date: ${order.createdAt.toLocaleDateString()}`);
  doc.text(`Payment Method: ${order.paymentMethod}`);
  doc.text(`Payment Status: ${order.paymentStatus}`);
  doc.text(`Order Status: ${order.status}`);
  doc.moveDown();

  doc.text("Items:", { underline: true });
  order.items.forEach((item) => {
    doc.text(`${item.nameSnapshot} x ${item.quantity} - NGN ${item.priceSnapshot.toLocaleString()}`);
  });

  doc.moveDown();
  doc.text(`Subtotal: NGN ${order.subtotal.toLocaleString()}`);
  doc.text(`Tax: NGN ${order.tax.toLocaleString()}`);
  doc.text(`Shipping: NGN ${order.shippingCost.toLocaleString()}`);
  doc.fontSize(14).text(`Total: NGN ${order.total.toLocaleString()}`, { bold: true });

  doc.end();
});
