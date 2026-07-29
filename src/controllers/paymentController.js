import crypto from "crypto";
import axios from "axios";
import Order from "../models/Order.js";
import { env } from "../config/env.js";
import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import { ORDER_STATUS } from "../utils/constants.js";

export const initiatePayment = catchAsync(async (req, res) => {
  const { orderId } = req.body;
  const user = req.user;

  const order = await Order.findOne({
    _id: orderId,
    userId: user.id,
    paymentStatus: "pending",
  });

  if (!order) throw new AppError("Order not found", 404);

  const response = await axios.post(
    "https://api.paystack.co/transaction/initialize",
    {
      email: user.email,
      amount: Math.round(order.total * 100), // kobo
      reference: order._id.toString(),
      metadata: { orderId: order._id.toString() },
    },
    {
      headers: {
        Authorization: `Bearer ${env.paystackSecretKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  res.status(200).json({
    status: "success",
    data: { authorizationUrl: response.data.data.authorization_url },
  });
});

export const handleWebhook = catchAsync(async (req, res) => {
  const hash = crypto
    .createHmac("sha512", env.paystackSecretKey)
    .update(req.body)
    .digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    return res.sendStatus(401);
  }

  const event = JSON.parse(req.body.toString());

  if (event.event === "charge.success") {
    const orderId = event.data.metadata.orderId;
    // idempotency guard — Paystack may retry delivery of the same event
    await Order.updateOne(
      { _id: orderId, paymentStatus: "pending" },
      { paymentStatus: "paid", status: ORDER_STATUS.PAID, orderStatus: "processing" }
    );
  }

  res.sendStatus(200);
});
