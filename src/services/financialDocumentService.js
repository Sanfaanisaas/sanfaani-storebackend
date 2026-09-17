import mongoose from "mongoose";
import FinancialDocument from "../models/FinancialDocument.js";
import Order from "../models/Order.js";
import Payment from "../models/Payment.js";
import AppError from "../utils/AppError.js";

const unavailable = () =>
  new AppError("Financial document is unavailable", 404, [
    {
      code: "financial_document_unavailable",
      message: "Check the order reference and account",
    },
  ]);

const financialItemsFor = (order) => {
  if (Array.isArray(order.items) && order.items.length > 0) return order.items.map((item) => ({
    name: item.nameSnapshot,
    sku: item.variantSku,
    unitAmount: item.priceSnapshot,
    quantity: item.quantity,
    lineTotal: item.priceSnapshot * item.quantity,
  }));
  if (order?.orderSource === "B2B_QUOTATION" && order.procurementSnapshot?.lineItems?.length) {
    return order.procurementSnapshot.lineItems.map((item, index) => ({
      name: item.description,
      sku: `B2B-${order.procurementSnapshot.quotationId}-${index + 1}`,
      unitAmount: item.unitPrice,
      quantity: item.quantity,
      lineTotal: item.totalAmount,
    }));
  }
  return [];
};

const snapshotFor = (order, paidAt = null) => ({
  items: financialItemsFor(order),
  subtotal: order.subtotal,
  tax: order.tax,
  shipping: order.shippingCost,
  total: order.total,
  paymentMethod: order.paymentMethod,
  paidAt,
});

export const canSnapshotFinancialOrder = (order) => {
  const items = financialItemsFor(order);
  const amounts = [order?.subtotal, order?.tax, order?.shippingCost, order?.total];
  if (
    items.length === 0
    || !amounts.every((amount) => Number.isSafeInteger(amount) && amount >= 0)
  ) return false;

  const subtotal = items.reduce((sum, item) => {
    if (
      !Number.isSafeInteger(item?.unitAmount)
      || item.unitAmount < 0
      || !Number.isSafeInteger(item?.quantity)
      || item.quantity < 1
      || typeof item?.name !== "string"
      || !item.name.trim()
      || typeof item?.sku !== "string"
      || !item.sku.trim()
      || item.lineTotal !== item.unitAmount * item.quantity
    ) return Number.NaN;
    return sum + item.lineTotal;
  }, 0);

  return subtotal === order.subtotal
    && order.subtotal + order.tax + order.shippingCost === order.total;
};

const documentNumber = (prefix, id) =>
  `SF-${prefix}-${String(id).toUpperCase()}`;

const createIfMissing = async ({ kind, order, payment = null, session }) => {
  const documentKey =
    kind === "INVOICE"
      ? `invoice:${order._id}`
      : `receipt:${payment._id}`;
  const existing = await FinancialDocument.findOne({ documentKey }).session(session);
  if (existing) return existing;
  const [created] = await FinancialDocument.create(
    [
      {
        documentKey,
        documentNumber: documentNumber(
          kind === "INVOICE" ? "INV" : "RCP",
          kind === "INVOICE" ? order._id : payment._id,
        ),
        kind,
        order: order._id,
        payment: payment?._id || null,
        owner: order.userId,
        currency: payment?.currency || order.procurementSnapshot?.currency || "NGN",
        issuedAt: new Date(),
        snapshot: snapshotFor(order, payment?.verifiedAt || null),
      },
    ],
    { session },
  );
  return created;
};

export const createVerifiedFinancialDocuments = async ({ order, payment, session }) => {
  if (!session) throw new TypeError("A transaction session is required");
  if (
    payment.status !== "SUCCEEDED"
    || payment.subjectType !== "order"
    || payment.subjectId.toString() !== order._id.toString()
    || payment.owner.toString() !== order.userId.toString()
    || payment.amount !== order.total
    || payment.currency !== "NGN"
  ) {
    throw new AppError("Verified payment binding is inconsistent", 409, [
      {
        code: "financial_document_binding_invalid",
        message: "The verified payment does not match this order",
      },
    ]);
  }
  const invoice = await createIfMissing({ kind: "INVOICE", order, payment, session });
  const receipt = await createIfMissing({ kind: "RECEIPT", order, payment, session });
  return { invoice, receipt };
};

const runTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};

export const getOwnerInvoice = async ({ orderId, ownerId }) => {
  if (!mongoose.isObjectIdOrHexString(orderId)) throw unavailable();
  try {
    return await runTransaction(async (session) => {
      const order = await Order.findOne({ _id: orderId, userId: ownerId }).session(session);
      if (!order) throw unavailable();
      return createIfMissing({ kind: "INVOICE", order, session });
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await FinancialDocument.findOne({ kind: "INVOICE", order: orderId, owner: ownerId });
    if (!existing) throw error;
    return existing;
  }
};

export const getOwnerReceipt = async ({ orderId, ownerId }) => {
  if (!mongoose.isObjectIdOrHexString(orderId)) throw unavailable();
  return runTransaction(async (session) => {
    const order = await Order.findOne({
      _id: orderId,
      userId: ownerId,
      paymentStatus: "paid",
    }).session(session);
    if (!order) throw unavailable();
    const existing = await FinancialDocument.findOne({
      kind: "RECEIPT",
      order: order._id,
      owner: ownerId,
    }).session(session);
    if (existing) return existing;
    const payment = await Payment.findOne({
      subjectType: "order",
      subjectId: order._id,
      owner: ownerId,
      status: "SUCCEEDED",
      capturedAmount: order.total,
      netPaidAmount: order.total,
    })
      .sort({ verifiedAt: -1, _id: -1 })
      .session(session);
    if (!payment) throw unavailable();
    const { receipt } = await createVerifiedFinancialDocuments({ order, payment, session });
    return receipt;
  });
};

export const toPublicFinancialDocument = (document) => ({
  id: document._id,
  documentNumber: document.documentNumber,
  kind: document.kind,
  orderId: document.order,
  currency: document.currency,
  issuedAt: document.issuedAt,
  items: document.snapshot.items,
  subtotal: document.snapshot.subtotal,
  tax: document.snapshot.tax,
  shipping: document.snapshot.shipping,
  total: document.snapshot.total,
  paymentMethod: document.snapshot.paymentMethod,
  paidAt: document.snapshot.paidAt,
});
