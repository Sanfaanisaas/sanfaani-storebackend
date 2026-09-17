import Order from "../models/Order.js";
import mongoose from "mongoose";
import { isPayOnPickupEligible } from "../services/orderService.js";
import { catchAsync } from "../utils/catchAsync.js";
import pdfkit from "pdfkit";
import {
  getOwnerInvoice,
  getOwnerReceipt,
} from "../services/financialDocumentService.js";
import {
  attachBankTransferEvidence,
  verifyBankTransferPayment,
} from "../services/manualPaymentService.js";
import {
  cancelOrderWithReservations,
  fulfillOrder,
  confirmDelivery,
} from "../services/reservationService.js";

/**
 * Get authenticated user's orders with pagination
 */
export const getMyOrders = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const skip = (page - 1) * limit;

  const query = { userId: req.user.id };

  const [orders, totalCount] = await Promise.all([
    Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
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
 * Get authenticated user's specific order by ID (Owner-scoped, non-enumerating)
 */
export const getOrderById = catchAsync(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }
  const order = await Order.findOne({ _id: id, userId: req.user.id });
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }
  res.status(200).json({ success: true, data: order.toPublicOrder() });
});

/**
 * Upload manual payment receipt
 */
export const uploadReceipt = catchAsync(async (req, res) => {
  const result = await attachBankTransferEvidence({
    orderId: req.params.id,
    ownerId: req.user.id,
    file: req.file,
  });
  res.status(201).json({
    success: true,
    data: {
      order: result.order.toPublicOrder(),
      payment: result.payment,
      evidence: result.evidence,
    },
  });
});

/**
 * Check if order is eligible for pickup
 */
export const checkEligiblePickup = catchAsync(async (req, res) => {
  const id = req.params.id || req.query.orderId;
  const order = mongoose.isObjectIdOrHexString(id)
    ? await Order.findOne({ _id: id, userId: req.user.id })
    : null;
  if (!order) {
    return res.status(404).json({
      success: false,
      message: "Order information is unavailable",
      errors: [{ code: "order_unavailable", message: "Check the order reference and permissions" }],
    });
  }
  const eligible = order.paymentMethod === "pay_on_pickup"
    && order.paymentStatus === "pending"
    && isPayOnPickupEligible(order);

  res.status(200).json({
    success: true,
    data: {
      eligible,
      expiresAt: order.payOnPickupExpiresAt,
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
  const order = await verifyBankTransferPayment({
    orderId: req.params.id,
    actorId: req.user.id,
  });
  res.status(200).json({
    success: true,
    data: order.toPublicOrder(),
  });
});

export const cancelOrder = catchAsync(async (req, res) => {
  const order = await cancelOrderWithReservations({
    orderId: req.params.id,
    ownerId: req.user.id,
    actorId: req.user.id,
    actorRole: req.user.role,
  });
  res.json({ success: true, data: order.toPublicOrder() });
});

export const dispatchOrder = catchAsync(async (req, res) => {
  const order = await fulfillOrder({
    orderId: req.params.id,
    actorId: req.user.id,
    action: "dispatch",
    metadata: req.body,
  });
  res.json({ success: true, data: order.toPublicOrder() });
});

export const collectOrder = catchAsync(async (req, res) => {
  const order = await fulfillOrder({
    orderId: req.params.id,
    actorId: req.user.id,
    action: "collect",
    metadata: req.body,
  });
  res.json({ success: true, data: order.toPublicOrder() });
});

export const deliverOrder = catchAsync(async (req, res) => {
  const order = await confirmDelivery({
    orderId: req.params.id,
    actorId: req.user.id,
  });
  res.json({ success: true, data: order.toPublicOrder() });
});

/**
 * Generate and stream PDF receipt
 */
export const generateReceiptPDF = catchAsync(async (req, res) => {
  const document = await getOwnerReceipt({ orderId: req.params.id, ownerId: req.user.id });
  streamFinancialDocument(document, res);
});

export const generateInvoicePDF = catchAsync(async (req, res) => {
  const document = await getOwnerInvoice({ orderId: req.params.id, ownerId: req.user.id });
  streamFinancialDocument(document, res);
});

const streamFinancialDocument = (document, res) => {
  const doc = new pdfkit();
  const label = document.kind === "RECEIPT" ? "Receipt" : "Invoice";
  const filename = `${document.kind.toLowerCase()}_${document.order}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

  doc.pipe(res);

  // PDF Content
  doc.fontSize(20).text(`Order ${label}`, { align: "center" });
  doc.moveDown();
  doc.fontSize(12).text(`Document: ${document.documentNumber}`);
  doc.text(`Order ID: ${document.order}`);
  doc.text(`Issued: ${document.issuedAt.toISOString()}`);
  doc.text(`Payment Method: ${document.snapshot.paymentMethod}`);
  if (document.snapshot.paidAt) doc.text(`Paid: ${document.snapshot.paidAt.toISOString()}`);
  doc.moveDown();

  doc.text("Items:", { underline: true });
  document.snapshot.items.forEach((item) => {
    doc.text(
      `${item.name} x ${item.quantity} - ${document.currency} ${item.lineTotal.toLocaleString()}`,
    );
  });

  doc.moveDown();
  doc.text(`Subtotal: ${document.currency} ${document.snapshot.subtotal.toLocaleString()}`);
  doc.text(`Tax: ${document.currency} ${document.snapshot.tax.toLocaleString()}`);
  doc.text(`Shipping: ${document.currency} ${document.snapshot.shipping.toLocaleString()}`);
  doc
    .fontSize(14)
    .text(`Total: ${document.currency} ${document.snapshot.total.toLocaleString()}`, { bold: true });

  doc.end();
};

/**
 * Filterable order queue for staff
 */
export const getOrderQueue = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const skip = (page - 1) * limit;

  const { status, paymentMethod, dateFrom, dateTo, search } = req.query;
  const query = {};

  if (status) query.status = status;
  if (paymentMethod) query.paymentMethod = paymentMethod;
  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
    if (dateTo) query.createdAt.$lte = new Date(dateTo);
  }

  if (search) {
    // Escape search for regex
    const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const searchRegex = new RegExp(escapedSearch, "i");

    // Search by Order ID or User Email
    // Note: To search by email, we might need to find users first or use aggregation
    const matchingUsers = await mongoose
      .model("User")
      .find({ email: searchRegex })
      .select("_id");
    const userIds = matchingUsers.map((u) => u._id);

    query.$or = [{ userId: { $in: userIds } }];

    if (mongoose.Types.ObjectId.isValid(search)) {
      query.$or.push({ _id: search });
    }
  }

  const [orders, total] = await Promise.all([
    Order.find(query)
      .populate("userId", "name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Order.countDocuments(query),
  ]);

  res.status(200).json({
    success: true,
    data: orders,
    pagination: {
      total,
      page,
      pages: Math.ceil(total / limit),
    },
  });
});
