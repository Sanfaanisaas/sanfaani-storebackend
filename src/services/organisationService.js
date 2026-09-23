import mongoose from "mongoose";
import Organisation from "../models/Organisation.js";
import OrganisationMember from "../models/OrganisationMember.js";
import { writeAuditLog } from "./auditService.js";
import {
  conflict,
  fingerprint,
  idText,
  isObjectId,
  requireIdempotencyKey,
  unavailable,
} from "./customerDomainService.js";

const organisationDto = (organisation, membership) => ({
  id: idText(organisation._id),
  name: organisation.name,
  type: organisation.type,
  billingEmail: organisation.billingEmail,
  status: organisation.status,
  membership: membership ? {
    role: membership.role,
    status: membership.status,
    canPurchase: Boolean(membership.canPurchase),
  } : null,
  createdAt: organisation.createdAt,
  updatedAt: organisation.updatedAt,
});

const membershipDto = (membership) => ({
  id: idText(membership._id),
  organisationId: idText(membership.organisation),
  userId: idText(membership.user),
  role: membership.role,
  status: membership.status,
  canPurchase: Boolean(membership.canPurchase),
  createdAt: membership.createdAt,
  updatedAt: membership.updatedAt,
});

export const createOrganisation = async ({ actor, input, idempotencyKey }) => {
  const key = requireIdempotencyKey(idempotencyKey);
  const normalized = {
    name: input.name.trim(),
    normalizedName: input.name.trim().toLowerCase().replace(/\s+/g, " "),
    type: input.type,
    billingEmail: input.billingEmail.trim().toLowerCase(),
  };
  const hash = fingerprint(normalized);
  const existing = await Organisation.findOne({ createdBy: actor, idempotencyKey: key });
  if (existing) {
    if (existing.idempotencyFingerprint !== hash) {
      throw conflict("organisation_idempotency_conflict", "This idempotency key is associated with different organisation details");
    }
    const membership = await OrganisationMember.findOne({ organisation: existing._id, user: actor });
    return { organisation: organisationDto(existing, membership), replayed: true };
  }

  const session = await mongoose.startSession();
  try {
    let organisation;
    let membership;
    await session.withTransaction(async () => {
      [organisation] = await Organisation.create([{
        ...normalized,
        createdBy: actor,
        idempotencyKey: key,
        idempotencyFingerprint: hash,
      }], { session });
      [membership] = await OrganisationMember.create([{
        organisation: organisation._id,
        user: actor,
        role: "OWNER",
        status: "ACTIVE",
        canPurchase: true,
        invitedBy: actor,
      }], { session });
      await writeAuditLog(actor, "ORGANISATION_CREATED", "Organisation", organisation._id, {
        type: organisation.type,
      }, session);
    });
    return { organisation: organisationDto(organisation, membership), replayed: false };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const replay = await Organisation.findOne({ createdBy: actor, idempotencyKey: key });
    if (!replay || replay.idempotencyFingerprint !== hash) {
      throw conflict("organisation_idempotency_conflict", "This idempotency key is associated with different organisation details");
    }
    const membership = await OrganisationMember.findOne({ organisation: replay._id, user: actor });
    return { organisation: organisationDto(replay, membership), replayed: true };
  } finally {
    await session.endSession();
  }
};

export const listOrganisations = async ({ actor }) => {
  const memberships = await OrganisationMember.find({ user: actor, status: "ACTIVE" }).sort({ updatedAt: -1 });
  const organisations = await Organisation.find({ _id: { $in: memberships.map((item) => item.organisation) } });
  const byId = new Map(organisations.map((item) => [idText(item._id), item]));
  return memberships.flatMap((membership) => {
    const organisation = byId.get(idText(membership.organisation));
    return organisation ? [organisationDto(organisation, membership)] : [];
  });
};

export const requireActiveMember = async ({ organisationId, userId, purchase = false, session = null }) => {
  if (!isObjectId(organisationId)) throw unavailable("Procurement quotation");
  const membership = await OrganisationMember.findOne({
    organisation: organisationId,
    user: userId,
    status: "ACTIVE",
    ...(purchase ? { canPurchase: true, role: { $in: ["OWNER", "ADMIN", "BUYER"] } } : {}),
  }).session(session);
  if (!membership) throw unavailable("Procurement quotation");
  return membership;
};

export const addOrUpdateMember = async ({ actor, organisationId, input }) => {
  if (!isObjectId(organisationId)) throw unavailable("Organisation");
  const actorMembership = await OrganisationMember.findOne({
    organisation: organisationId,
    user: actor,
    status: "ACTIVE",
    role: { $in: ["OWNER", "ADMIN"] },
  });
  if (!actorMembership) throw unavailable("Organisation");
  if (input.role === "OWNER" && actorMembership.role !== "OWNER") {
    throw unavailable("Organisation");
  }
  const organisation = await Organisation.findOne({ _id: { $eq: organisationId }, status: "ACTIVE" });
  if (!organisation) throw conflict("organisation_inactive", "The organisation is not active");

  const canPurchase = ["OWNER", "ADMIN", "BUYER"].includes(input.role);
  const membership = await OrganisationMember.findOneAndUpdate(
    { organisation: organisationId, user: input.userId },
    {
      $set: { role: input.role, status: "ACTIVE", canPurchase, revokedAt: null },
      $setOnInsert: { invitedBy: actor },
    },
    { upsert: true, returnDocument: "after", runValidators: true },
  );
  await writeAuditLog(actor, "ORGANISATION_MEMBER_UPDATED", "OrganisationMember", membership._id, {
    role: membership.role,
    canPurchase: membership.canPurchase,
  });
  return membershipDto(membership);
};

export const listMembers = async ({ actor, organisationId }) => {
  await requireActiveMember({ organisationId, userId: actor });
  return (await OrganisationMember.find({ organisation: organisationId }).sort({ createdAt: 1 })).map(membershipDto);
};
