import crypto from "node:crypto";
import GuidanceSession from "../models/GuidanceSession.js";
import Variant from "../models/Variant.js";
import Product from "../models/Product.js";
import AppError from "../utils/AppError.js";
import { env } from "../config/env.js";
import { deriveAvailability } from "../utils/projections.js";

const secret = () => env.guidanceTokenSecret || env.securityAuditHmacSecret;
const digest = (token) => crypto.createHmac("sha256", secret()).update(token).digest("hex");
const safe = (session) => ({ id: session._id.toString(), budget: session.budget, useCase: session.useCase, brands: session.brands, categories: session.categories, requiredFeatures: session.requiredFeatures, status: session.status, recommendations: session.recommendations.map((item) => ({ variant: item.variant.toString(), score: item.score, factors: item.factors, availability: item.availability })), updatedAt: session.updatedAt });
export const createGuidance = async ({ owner = null, budget = null, useCase = null, brands = [], categories = [], requiredFeatures = [] }) => {
  if (budget !== null && (!Number.isSafeInteger(budget) || budget < 0)) throw new AppError("Budget must be a non-negative integer", 400);
  const products = await Product.find({ status: "active", ...(categories.length ? { category: { $in: categories.slice(0, 10) } } : {}), ...(brands.length ? { brand: { $in: brands.slice(0, 10) } } : {}) }).select("_id").lean();
  const variants = products.length ? await Variant.find({ product: { $in: products.map((p) => p._id) }, ...(budget !== null ? { price: { $lte: budget } } : {}) }).lean() : [];
  const recommendations = variants.filter((variant) => ["in_stock", "low_stock"].includes(deriveAvailability(variant))).sort((a, b) => a.price - b.price || a.sku.localeCompare(b.sku)).slice(0, 10).map((variant, index) => ({ variant: variant._id, score: 100 - index, factors: [budget !== null ? "within_budget" : "catalogue_match", "currently_available"], availability: deriveAvailability(variant) }));
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const session = await GuidanceSession.create({ owner, budget, useCase: typeof useCase === "string" ? useCase.slice(0, 120) : null, brands: brands.slice(0, 10), categories: categories.slice(0, 10), requiredFeatures: requiredFeatures.slice(0, 20), recommendations, status: recommendations.length ? "ACTIVE" : "NO_MATCH", resumeDigest: digest(rawToken), resumeExpiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30) });
  return { session: safe(session), resumeToken: rawToken, expiresAt: session.resumeExpiresAt };
};
export const resumeGuidance = async ({ id, token, owner = null }) => {
  const query = owner ? { _id: id, owner } : { _id: id, resumeDigest: digest(token), resumeRevokedAt: null, resumeExpiresAt: { $gt: new Date() } };
  const session = await GuidanceSession.findOne(query);
  if (!session) throw new AppError("Guidance session is unavailable", 404);
  return safe(session);
};
