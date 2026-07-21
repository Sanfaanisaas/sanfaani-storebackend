import Order from "../models/Order.js";
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

  const query = { user: req.user.id };

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
  const order = await Order.findOne({ _id: id, user: req.user.id });

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
  // Real geolocation is a future ticket. Returning true unconditionally for now.
  res.status(200).json({
    success: true,
    data: {
      eligible: true,
      message: "Pickup eligibility stub: always true for now.",
    },
  });
});

/**
 * Generate and stream PDF receipt
 */
export const generateReceiptPDF = catchAsync(async (req, res) => {
  const { id } = req.params;
  const order = await Order.findById(id).populate("user", "email");

  if (!order) {
    return res.status(404).json({
      success: false,
      message: "Order not found",
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
  doc.text(`Order Status: ${order.orderStatus}`);
  doc.moveDown();

  doc.text("Items:", { underline: true });
  order.items.forEach((item) => {
    doc.text(`${item.name} x ${item.quantity} - NGN ${item.price.toLocaleString()}`);
  });

  doc.moveDown();
  doc.text(`Subtotal: NGN ${order.subtotal.toLocaleString()}`);
  doc.text(`Tax: NGN ${order.tax.toLocaleString()}`);
  doc.text(`Shipping: NGN ${order.shippingCost.toLocaleString()}`);
  doc.fontSize(14).text(`Total: NGN ${order.total.toLocaleString()}`, { bold: true });

  doc.end();
});
