import mongoose from "mongoose";
import Order from "../models/Order.js";
import Organisation from "../models/Organisation.js";
import ProcurementQuotation from "../models/ProcurementQuotation.js";
import ProcurementRequest from "../models/ProcurementRequest.js";
import { ORDER_STATUS } from "../utils/constants.js";
import { writeAuditLog } from "./auditService.js";
import { conflict, fingerprint, idText, requireIdempotencyKey, unavailable } from "./customerDomainService.js";
import { requireActiveMember } from "./organisationService.js";

const addressSnapshot = (address) => ({
  street: address.street.trim(),
  city: address.city.trim(),
  state: address.state.trim(),
  postalCode: address.postalCode?.trim() || undefined,
  country: address.country.trim(),
});

const publicSnapshot = (snapshot) => snapshot ? ({
  organisationId: idText(snapshot.organisationId),
  requestId: idText(snapshot.requestId),
  quotationId: idText(snapshot.quotationId),
  quotationVersion: snapshot.quotationVersion,
  lineItems: snapshot.lineItems.map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    totalAmount: item.totalAmount,
  })),
  subtotal: snapshot.subtotal,
  tax: snapshot.tax,
  fees: snapshot.fees,
  fulfilmentCharge: snapshot.fulfilmentCharge,
  totalAmount: snapshot.totalAmount,
  currency: snapshot.currency,
  termsVersion: snapshot.termsVersion,
  warrantySummary: snapshot.warrantySummary || null,
  supportSummary: snapshot.supportSummary || null,
  validUntil: snapshot.validUntil,
  approvedAt: snapshot.approvedAt,
  purchaseOrderReference: snapshot.purchaseOrderReference || null,
}) : null;

const orderDto = (order) => ({
  id: idText(order._id),
  userId: idText(order.userId),
  orderSource: order.orderSource,
  procurementSnapshot: publicSnapshot(order.procurementSnapshot),
  shippingAddress: order.shippingAddress,
  subtotal: order.subtotal,
  tax: order.tax,
  shippingCost: order.shippingCost,
  total: order.total,
  paymentMethod: order.paymentMethod,
  paymentStatus: order.paymentStatus,
  status: order.status,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});

const conversionConflict = (code, message) => conflict(code, message);

export const convertQuotationToOrder = async ({ actor, quotationId, input, idempotencyKey }) => {
  const key = requireIdempotencyKey(idempotencyKey);
  const normalized = {
    organisationId: input.organisationId,
    expectedVersion: input.expectedVersion,
    paymentMethod: input.paymentMethod,
    shippingAddress: addressSnapshot(input.shippingAddress),
    purchaseOrderReference: input.purchaseOrderReference?.trim() || null,
  };
  const hash = fingerprint(normalized);
  const session = await mongoose.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      await requireActiveMember({ organisationId: normalized.organisationId, userId: actor, purchase: true, session });
      const organisation = await Organisation.findById(normalized.organisationId).session(session);
      if (!organisation) throw unavailable("Procurement quotation");
      if (organisation.status !== "ACTIVE") {
        throw conversionConflict("organisation_inactive", "The organisation is not active");
      }

      const quotation = await ProcurementQuotation.findOne({
        _id: quotationId,
        organisation: organisation._id,
      }).session(session);
      if (!quotation) throw unavailable("Procurement quotation");

      const existingOrder = await Order.findOne({
        "procurementSnapshot.quotationId": quotation._id,
      }).select("+procurementConversion.idempotencyKey +procurementConversion.idempotencyFingerprint").session(session);
      if (existingOrder) {
        if (existingOrder.procurementConversion?.idempotencyKey === key) {
          if (existingOrder.procurementConversion.idempotencyFingerprint !== hash) {
            throw conversionConflict("procurement_conversion_idempotency_conflict", "This idempotency key is associated with different conversion details");
          }
          result = { order: orderDto(existingOrder), replayed: true };
          return;
        }
        throw conversionConflict("procurement_quote_already_converted", "This quotation has already been converted to an order");
      }

      const now = new Date();
      if (quotation.version !== normalized.expectedVersion) {
        throw conversionConflict("procurement_quote_version_conflict", "The quotation version has changed");
      }
      if (quotation.status !== "APPROVED" || quotation.superseded || quotation.decision?.type !== "APPROVED") {
        throw conversionConflict("procurement_quote_not_convertible", "This quotation cannot be converted to an order");
      }
      if (quotation.validUntil <= now) {
        throw conversionConflict("procurement_quote_expired", "This quotation has expired");
      }
      if (quotation.conversionStatus === "CONVERTED" || quotation.order) {
        throw conversionConflict("procurement_quote_already_converted", "This quotation has already been converted to an order");
      }
      const latestQuotation = await ProcurementQuotation.findOne({ request: quotation.request })
        .sort({ version: -1, _id: -1 })
        .select("_id version")
        .session(session);
      if (!latestQuotation || !latestQuotation._id.equals(quotation._id)) {
        throw conversionConflict("procurement_quote_not_current", "A newer quotation version exists");
      }

      const procurementRequest = await ProcurementRequest.findOne({
        _id: quotation.request,
        organisation: organisation._id,
      }).session(session);
      if (!procurementRequest) throw unavailable("Procurement quotation");

      const snapshot = {
        organisationId: organisation._id,
        requestId: procurementRequest._id,
        quotationId: quotation._id,
        quotationVersion: quotation.version,
        lineItems: quotation.lineItems.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalAmount: item.totalAmount,
        })),
        subtotal: quotation.subtotal,
        tax: quotation.tax,
        fees: quotation.fees,
        fulfilmentCharge: quotation.fulfilmentCharge,
        totalAmount: quotation.totalAmount,
        currency: quotation.currency,
        termsVersion: quotation.termsVersion,
        warrantySummary: quotation.warrantySummary || null,
        supportSummary: quotation.supportSummary || null,
        validUntil: quotation.validUntil,
        approvedAt: quotation.decision.at,
        purchaseOrderReference: normalized.purchaseOrderReference,
      };

      const [order] = await Order.create([{
        userId: actor,
        items: [],
        shippingAddress: normalized.shippingAddress,
        subtotal: quotation.subtotal,
        tax: quotation.tax + quotation.fees,
        shippingCost: quotation.fulfilmentCharge,
        total: quotation.totalAmount,
        paymentMethod: normalized.paymentMethod,
        paymentStatus: "pending",
        status: ORDER_STATUS.PENDING_PAYMENT,
        orderSource: "B2B_QUOTATION",
        procurementSnapshot: snapshot,
        procurementConversion: {
          idempotencyKey: key,
          idempotencyFingerprint: hash,
          convertedBy: actor,
        },
      }], { session });

      quotation.conversionStatus = "CONVERTED";
      quotation.order = order._id;
      await quotation.save({ session });
      procurementRequest.status = "CONVERTED_TO_ORDER";
      procurementRequest.timeline.push({
        status: "CONVERTED_TO_ORDER",
        at: now,
        message: "Approved quotation converted to an organisation order.",
      });
      await procurementRequest.save({ session });
      await writeAuditLog(actor, "B2B_QUOTATION_CONVERTED", "ProcurementQuotation", quotation._id, {
        organisationId: idText(organisation._id),
        orderId: idText(order._id),
        quotationVersion: quotation.version,
        totalAmount: quotation.totalAmount,
        currency: quotation.currency,
      }, session);
      result = { order: orderDto(order), replayed: false };
    });
    return result;
  } catch (error) {
    if (error?.code === 11000) {
      const replay = await Order.findOne({ "procurementSnapshot.quotationId": quotationId })
        .select("+procurementConversion.idempotencyKey +procurementConversion.idempotencyFingerprint");
      if (replay?.procurementConversion?.idempotencyKey === key && replay.procurementConversion.idempotencyFingerprint === hash) {
        return { order: orderDto(replay), replayed: true };
      }
      throw conversionConflict("procurement_quote_already_converted", "This quotation has already been converted to an order");
    }
    throw error;
  } finally {
    await session.endSession();
  }
};
