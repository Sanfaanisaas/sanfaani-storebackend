import crypto from "node:crypto";
import GuidanceSession from "../models/GuidanceSession.js";
import GuidanceEscalation from "../models/GuidanceEscalation.js";
import Variant from "../models/Variant.js";
import Product from "../models/Product.js";
import AppError from "../utils/AppError.js";
import { env } from "../config/env.js";
import { deriveAvailability } from "../utils/projections.js";
import { conflict, idText, isObjectId, pageInput, pagination, unavailable } from "./customerDomainService.js";
import { createCustomerNotification } from "./notificationService.js";
import { writeAuditLog } from "./auditService.js";

const RULES_VERSION = "catalogue-budget-v1";
const secret = () => env.guidanceTokenSecret || env.securityAuditHmacSecret;
const digest = (token) => crypto.createHmac("sha256", secret()).update(String(token || "")).digest("hex");

const safe = (session) => ({
  id: idText(session._id),
  budget: session.budget,
  useCase: session.useCase,
  brands: session.brands,
  categories: session.categories,
  requiredFeatures: session.requiredFeatures,
  requirementsSummary: session.requirementsSummary || {
    budget: session.budget,
    useCase: session.useCase,
    brands: session.brands,
    categories: session.categories,
    requiredFeatures: session.requiredFeatures,
  },
  rulesVersion: session.rulesVersion || RULES_VERSION,
  evaluatedAt: session.evaluatedAt || session.createdAt,
  staleAt: session.staleAt || null,
  status: session.status,
  recommendations: (session.recommendations || []).map((item) => ({
    variant: idText(item.variant),
    score: item.score,
    factors: item.factors,
    availability: item.availability,
  })),
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
});

const activeEscalation = async (session, owner) => {
  const escalation = await GuidanceEscalation.findOne({ guidanceSession: session._id, customer: owner, active: true }).lean();
  return escalation
    ? {
        id: idText(escalation._id),
        status: escalation.status,
        question: escalation.question,
        response: escalation.response || null,
        advisorDisplayName: escalation.advisorDisplayName || null,
        createdAt: escalation.createdAt,
        updatedAt: escalation.updatedAt,
      }
    : null;
};

export const createGuidance = async ({ owner = null, budget = null, useCase = null, brands = [], categories = [], requiredFeatures = [] }) => {
  if (budget !== null && (!Number.isSafeInteger(budget) || budget < 0)) throw new AppError("Budget must be a non-negative integer", 400);
  const products = await Product.find({
    status: "active",
    ...(categories.length ? { category: { $in: categories.slice(0, 10) } } : {}),
    ...(brands.length ? { brand: { $in: brands.slice(0, 10) } } : {}),
  })
    .select("_id")
    .lean();

  const variants = products.length
    ? await Variant.find({ product: { $in: products.map((p) => p._id) }, ...(budget !== null ? { price: { $lte: budget } } : {}) }).lean()
    : [];

  const recommendations = variants
    .filter((variant) => ["in_stock", "low_stock"].includes(deriveAvailability(variant)))
    .sort((a, b) => a.price - b.price || a.sku.localeCompare(b.sku))
    .slice(0, 10)
    .map((variant, index) => ({
      variant: variant._id,
      score: 100 - index,
      factors: [budget !== null ? "within_budget" : "catalogue_match", "currently_available"],
      availability: deriveAvailability(variant),
    }));

  const rawToken = crypto.randomBytes(32).toString("base64url");
  const requirementsSummary = {
    budget,
    useCase: typeof useCase === "string" ? useCase.slice(0, 120) : null,
    brands: (brands || []).slice(0, 10),
    categories: (categories || []).slice(0, 10),
    requiredFeatures: (requiredFeatures || []).slice(0, 20),
  };

  const session = await GuidanceSession.create({
    owner,
    ...requirementsSummary,
    requirementsSummary,
    rulesVersion: RULES_VERSION,
    evaluatedAt: new Date(),
    staleAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
    recommendations,
    status: recommendations.length ? "ACTIVE" : "NO_MATCH",
    resumeDigest: digest(rawToken),
    resumeExpiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
  });

  return { session: safe(session), resumeToken: rawToken, expiresAt: session.resumeExpiresAt };
};

export const resumeGuidance = async ({ id, token, owner = null }) => {
  if (!isObjectId(id)) throw unavailable("Guidance session");
  if (!owner && (!token || typeof token !== "string" || !token.trim())) throw unavailable("Guidance session");
  const query = owner
    ? { _id: id, owner }
    : { _id: id, resumeDigest: digest(token.trim()), resumeRevokedAt: null, resumeExpiresAt: { $gt: new Date() } };
  const session = await GuidanceSession.findOne(query);
  if (!session) throw unavailable("Guidance session");
  return safe(session);
};

export const listOwnedGuidance = async ({ owner, query }) => {
  const { page, limit, skip } = pageInput(query);
  const [sessions, total] = await Promise.all([
    GuidanceSession.find({ owner }).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    GuidanceSession.countDocuments({ owner }),
  ]);
  return { sessions: sessions.map(safe), pagination: pagination(page, limit, total) };
};

export const archiveGuidance = async ({ owner, id }) => {
  if (!isObjectId(id)) throw unavailable("Guidance session");
  const session = await GuidanceSession.findOne({ _id: id, owner });
  if (!session) throw unavailable("Guidance session");
  if (session.status !== "ARCHIVED") {
    session.status = "ARCHIVED";
    session.archivedAt = new Date();
    session.resumeRevokedAt = new Date();
    await session.save();
    await writeAuditLog(owner, "GUIDANCE_ARCHIVED", "GuidanceSession", session._id, {});
  }
  return safe(session);
};

export const getGuidanceEscalation = async ({ owner, id }) => {
  if (!isObjectId(id)) throw unavailable("Guidance session");
  const session = await GuidanceSession.findOne({ _id: id, owner });
  if (!session) throw unavailable("Guidance session");
  return activeEscalation(session, owner);
};

export const createGuidanceEscalation = async ({ owner, id, question }) => {
  if (!isObjectId(id)) throw unavailable("Guidance session");
  const session = await GuidanceSession.findOne({ _id: id, owner, status: { $ne: "ARCHIVED" } });
  if (!session) throw unavailable("Guidance session");
  if (typeof question !== "string" || question.trim().length < 3 || question.trim().length > 1000) {
    throw new AppError("Guidance question is invalid", 400);
  }
  try {
    const escalation = await GuidanceEscalation.create({ guidanceSession: session._id, customer: owner, question: question.trim() });
    await writeAuditLog(owner, "GUIDANCE_ESCALATION_CREATED", "GuidanceEscalation", escalation._id, {});
    return {
      id: idText(escalation._id),
      status: escalation.status,
      question: escalation.question,
      response: null,
      advisorDisplayName: null,
      createdAt: escalation.createdAt,
      updatedAt: escalation.updatedAt,
    };
  } catch (error) {
    if (error?.code === 11000) throw conflict("guidance_escalation_active", "An active advisor request already exists for this guidance session");
    throw error;
  }
};

export const recordGuidanceAdvisorResponse = async ({ advisor, id, response, displayName = null }) => {
  if (!isObjectId(id) || typeof response !== "string" || response.trim().length < 1 || response.trim().length > 2000) throw unavailable("Guidance escalation");
  const escalation = await GuidanceEscalation.findById(id);
  if (!escalation) throw unavailable("Guidance escalation");
  escalation.response = response.trim();
  escalation.advisorDisplayName = displayName ? String(displayName).slice(0, 120) : null;
  escalation.status = "responded";
  escalation.respondedAt = new Date();
  escalation.active = false;
  await escalation.save();
  await createCustomerNotification({
    recipient: escalation.customer,
    type: "guidance_advisor_response",
    title: "Guidance advisor response",
    safePreview: "An advisor has responded to your guidance question.",
    resourceType: "guidance",
    resourceId: escalation.guidanceSession,
    mandatory: false,
    eventKey: `guidance-response:${escalation._id}`,
  });
  await writeAuditLog(advisor, "GUIDANCE_ADVISOR_RESPONDED", "GuidanceEscalation", escalation._id, {});
  return escalation;
};
