import crypto from "crypto";
import axios from "axios";
import Order from "../models/Order.js";
import { env } from "../config/env.js";
import { catchAsync } from "../utils/catchAsync.js";

export const initiatePayment = catchAsync(async (req, res) => {
  const { orderId, email: bodyEmail } = req.body;
  const user = req.user;

  const order = await Order.findOne({ _id: orderId, user: user._id });

  if (!order) {
    return res.status(404).json({
      success: false,
      message: "Order not found or does not belong to user",
    });
  }

  if (order.paymentStatus !== "pending") {
    return res.status(400).json({
      success: false,
      message: `Order cannot be paid. Payment status is ${order.paymentStatus}`,
    });
  }

  const email = bodyEmail || user.email;
  if (!email) {
    return res.status(400).json({
      success: false,
      message: "Email is required to initiate payment",
    });
  }

  const reference = crypto.randomUUID();
  order.paymentReference = reference;
  await order.save();

  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.round(order.total * 100),
        reference,
        callback_url: env.paystackCallbackUrl,
      },
      {
        headers: {
          Authorization: `Bearer ${env.paystackSecretKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.status(200).json({
      success: true,
      data: {
        authorization_url: response.data.data.authorization_url,
        reference: response.data.data.reference,
      },
    });
  } catch (error) {
    console.error("Paystack initialization error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Failed to initialize payment with Paystack",
      errors: error.response?.data || error.message,
    });
  }
});

export const handleWebhook = catchAsync(async (req, res) => {
  // Log for debugging (remove in production if too noisy)
  const signature = req.headers["x-paystack-signature"];
  
  if (!signature) {
    return res.status(400).json({ success: false, message: "Missing signature" });
  }

  // Debug: Log the raw body length and first 50 chars if possible
  // console.log("Raw body length:", req.body.length);

  const hash = crypto
    .createHmac("sha512", env.paystackSecretKey)
    .update(req.body) 
    .digest("hex");

  // Reverting to timingSafeEqual with careful length check
  const hashBuffer = Buffer.from(hash);
  const sigBuffer = Buffer.from(signature);

  if (hashBuffer.length !== sigBuffer.length || !crypto.timingSafeEqual(hashBuffer, sigBuffer)) {
    // console.error("Signature mismatch. Hash:", hash, "Signature:", signature);
    return res.status(400).json({ success: false, message: "Invalid signature" });
  }

  const event = JSON.parse(req.body.toString());

  if (event.event === "charge.success") {
    const { reference } = event.data;
    const order = await Order.findOne({ paymentReference: reference });

    if (order) {
      if (order.paymentStatus === "paid") {
        return res.status(200).send("Idempotent OK");
      }

      order.paymentStatus = "paid";
      order.orderStatus = "processing";
      await order.save();
    }
  }

  res.status(200).send("OK");
});
