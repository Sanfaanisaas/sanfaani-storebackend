import crypto from "node:crypto";
import axios from "axios";
import { env } from "../config/env.js";
import AppError from "../utils/AppError.js";

const timeout = 10_000;
const fail = () => new AppError("Payment provider is temporarily unavailable", 502, [{ code: "payment_provider_unavailable", message: "Please try again later" }]);
const normalizeTransaction = (data) => {
  if (!data || typeof data.reference !== "string" || !Number.isSafeInteger(data.amount) || typeof data.currency !== "string" || typeof data.status !== "string") throw fail();
  return { reference: data.reference, amount: data.amount, currency: data.currency, status: data.status, providerEventId: data.id == null ? null : String(data.id), paidAt: data.paid_at ? new Date(data.paid_at) : null, metadata: data.metadata && typeof data.metadata === "object" ? data.metadata : {} };
};
const production = {
  async initializePayment({ email, amount, reference, metadata }) {
    try { const response = await axios.post("https://api.paystack.co/transaction/initialize", { email, amount, reference, metadata }, { timeout, headers: { Authorization: `Bearer ${env.paystackSecretKey}`, "Content-Type": "application/json" } }); const data = response.data?.data; if (!data?.authorization_url || data.reference !== reference) throw fail(); return { authorizationUrl: data.authorization_url, reference: data.reference }; } catch (error) { if (error instanceof AppError) throw error; throw fail(); }
  },
  async verifyTransaction(reference) { try { return normalizeTransaction((await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { timeout, headers: { Authorization: `Bearer ${env.paystackSecretKey}` } })).data?.data); } catch { throw fail(); } },
  verifyWebhookSignature(rawBody, signature) { if (typeof signature !== "string") return false; const expected = crypto.createHmac("sha512", env.paystackSecretKey).update(rawBody).digest("hex"); return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); },
  async requestRefund() { throw new AppError("Refund provider integration is unavailable", 501); },
  async verifyRefund() { throw new AppError("Refund provider integration is unavailable", 501); },
};
let active = production;
export const getPaystackProvider = () => active;
export const setPaystackProviderForTests = (provider) => { active = provider || production; };
export const resetPaystackProviderForTests = () => { active = production; };
