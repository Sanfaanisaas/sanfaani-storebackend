import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import AuthSession from "../models/AuthSession.js";
import RefreshToken from "../models/RefreshToken.js";
import StaffInvitation from "../models/StaffInvitation.js";
import User from "../models/User.js";
import AppError from "../utils/AppError.js";
import { USER_ROLES } from "../utils/constants.js";
import { conflict, fingerprint, idText, isObjectId, pageInput, pagination, requireIdempotencyKey, unavailable } from "./customerDomainService.js";
import { writeAuditLog } from "./auditService.js";

const INVITATION_LIFETIME_MS = 48 * 60 * 60 * 1000;
const INVITED_PASSWORD_HASH = "$2b$12$STwmCXXAcG1juP88YSrvc.xvHyHZ6Kd.MLSEIDJg.cpO16B1PEc0K";
const ADMIN_ROLES = new Set([USER_ROLES.PRODUCT_ADMIN, USER_ROLES.SUPER_ADMIN]);
const PRIVILEGED_ROLES = new Set([USER_ROLES.OPS_MANAGER, USER_ROLES.PRODUCT_ADMIN, USER_ROLES.TECH_ADMIN, USER_ROLES.SUPER_ADMIN]);
const STAFF_ROLES = Object.values(USER_ROLES).filter((role) => role !== USER_ROLES.CUSTOMER);

export const ROLE_PERMISSIONS = Object.freeze({
  [USER_ROLES.CUSTOMER]: Object.freeze(["account.own", "commerce.own", "repair.own", "support.own"]),
  [USER_ROLES.SALES_ADVISOR]: Object.freeze(["dashboard.sales", "guidance.manage", "procurement.quote", "service.assess", "service.quote"]),
  [USER_ROLES.STORE_OPERATOR]: Object.freeze(["dashboard.store", "order.fulfil", "order.handover", "repair.intake", "repair.handover"]),
  [USER_ROLES.TECHNICIAN]: Object.freeze(["dashboard.assigned_repairs", "repair.diagnose", "repair.work", "service.assess", "service.execute"]),
  [USER_ROLES.QC_OFFICER]: Object.freeze(["dashboard.qc", "repair.qc"]),
  [USER_ROLES.INVENTORY_OFFICER]: Object.freeze(["dashboard.inventory", "inventory.manage", "procurement.manage"]),
  [USER_ROLES.SUPPORT_OFFICER]: Object.freeze(["claim.manage", "guidance.manage", "return.manage", "support.manage"]),
  [USER_ROLES.FINANCE_OFFICER]: Object.freeze(["finance.payment_verify", "finance.reconcile", "finance.refund", "finance.report"]),
  [USER_ROLES.MERCHANDISER]: Object.freeze(["catalogue.content", "content.manage", "promotion.manage"]),
  [USER_ROLES.OPS_MANAGER]: Object.freeze(["dashboard.operations", "inventory.govern", "order.govern", "procurement.govern", "repair.govern", "service.govern", "maintenance_plan.manage"]),
  [USER_ROLES.PRODUCT_ADMIN]: Object.freeze(["catalogue.admin", "content.publish", "policy.publish", "staff.manage_operational", "workflow.configure"]),
  [USER_ROLES.TECH_ADMIN]: Object.freeze(["backup.manage", "environment.manage", "integration.manage", "monitoring.manage", "technical_access.manage"]),
  [USER_ROLES.SUPER_ADMIN]: Object.freeze(["*"]),
});

const staffDto = (user) => ({
  id: idText(user._id),
  name: user.name,
  email: user.email,
  phone: user.phone || null,
  role: user.role,
  status: user.status,
  permissions: ROLE_PERMISSIONS[user.role] || [],
  version: user.adminVersion || 0,
  roleChangedAt: user.roleChangedAt || null,
  statusChangedAt: user.statusChangedAt || null,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const invitationUnavailable = () => unavailable("Staff invitation");
const forbidden = (code, message) => new AppError("You do not have permission to perform this action", 403, [{ code, message }]);
const invitationDigest = (token) => createHash("sha256").update(token).digest("hex");

const administrator = async (actor, session) => {
  const admin = await User.findOne({ _id: actor, role: { $in: [...ADMIN_ROLES] }, status: "ACTIVE" }).select("+authVersion").session(session || null);
  if (!admin) throw forbidden("staff_administration_forbidden", "An active staff administrator account is required");
  return admin;
};

const assertRoleAuthority = (admin, targetRole, currentRole = null) => {
  if (!STAFF_ROLES.includes(targetRole)) throw forbidden("staff_role_forbidden", "Customer and unknown roles cannot be assigned through staff administration");
  if (admin.role !== USER_ROLES.SUPER_ADMIN && (PRIVILEGED_ROLES.has(targetRole) || PRIVILEGED_ROLES.has(currentRole))) {
    throw forbidden("privileged_role_requires_super_admin", "Only a Super Administrator can manage privileged administrator roles");
  }
};

const revokeSessions = async (userId, reason, session) => {
  const now = new Date();
  const sessions = await AuthSession.find({ user: userId, revokedAt: null }).select("familyId").session(session);
  const families = sessions.map(({ familyId }) => familyId);
  await AuthSession.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: now, revocationReason: reason } }, { session });
  if (families.length) await RefreshToken.updateMany({ familyId: { $in: families }, status: { $ne: "revoked" } }, { $set: { status: "revoked", revokedAt: now, revocationReason: reason } }, { session });
};

const normalizeInvitation = (input) => ({ name: input.name.trim(), email: input.email.trim().toLowerCase(), phone: input.phone?.trim() || null, role: input.role });

export const inviteStaff = async ({ actor, input, idempotencyKey }) => {
  const key = requireIdempotencyKey(idempotencyKey);
  const normalized = normalizeInvitation(input);
  const hash = fingerprint(normalized);
  const rawToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
  const session = await mongoose.startSession();
  let staff;
  let invitation;
  let created = false;
  try {
    await session.withTransaction(async () => {
      const admin = await administrator(actor, session);
      assertRoleAuthority(admin, normalized.role);
      const replay = await StaffInvitation.findOne({ createdBy: actor, idempotencyKey: key }).select("+idempotencyFingerprint").session(session);
      if (replay) {
        if (replay.idempotencyFingerprint !== hash) throw conflict("staff_invitation_idempotency_conflict", "This idempotency key is associated with different invitation details");
        staff = await User.findById(replay.user).session(session);
        invitation = replay;
        return;
      }
      if (await User.exists({ email: normalized.email }).session(session)) throw conflict("staff_email_in_use", "An account already uses this email address");
      [staff] = await User.create([{ name: normalized.name, email: normalized.email, phone: normalized.phone, passwordHash: INVITED_PASSWORD_HASH, role: normalized.role, status: "INVITED", mustChangePassword: true, createdBy: actor }], { session });
      [invitation] = await StaffInvitation.create([{ user: staff._id, tokenDigest: invitationDigest(rawToken), expiresAt, createdBy: actor, idempotencyKey: key, idempotencyFingerprint: hash }], { session });
      await writeAuditLog(actor, "STAFF_INVITED", "User", staff._id, { role: staff.role }, session);
      created = true;
    });
  } catch (error) {
    if (error?.code === 11000) throw conflict("staff_email_in_use", "An account already uses this email address");
    throw error;
  } finally {
    await session.endSession();
  }
  return {
    created,
    staff: staffDto(staff),
    invitation: created ? { token: rawToken, expiresAt: invitation.expiresAt } : { expiresAt: invitation.expiresAt },
  };
};

export const acceptInvitation = async ({ token, password }) => {
  if (typeof token !== "string" || token.length < 43 || token.length > 128) throw invitationUnavailable();
  const hash = invitationDigest(token);
  const passwordHash = await bcrypt.hash(password, 12);
  const session = await mongoose.startSession();
  let staff;
  try {
    await session.withTransaction(async () => {
      const invitation = await StaffInvitation.findOne({ tokenDigest: hash, usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } }).session(session);
      if (!invitation) throw invitationUnavailable();
      staff = await User.findOne({ _id: invitation.user, status: "INVITED" }).select("+authVersion +mustChangePassword").session(session);
      if (!staff) throw invitationUnavailable();
      const now = new Date();
      staff.passwordHash = passwordHash;
      staff.status = "ACTIVE";
      staff.mustChangePassword = false;
      staff.statusChangedAt = now;
      staff.authVersion += 1;
      staff.adminVersion += 1;
      await staff.save({ session });
      invitation.usedAt = now;
      await invitation.save({ session });
      await writeAuditLog(staff._id, "STAFF_INVITATION_ACCEPTED", "User", staff._id, { role: staff.role }, session);
    });
    return staffDto(staff);
  } finally {
    await session.endSession();
  }
};

export const rotateInvitation = async ({ actor, staffId, idempotencyKey }) => {
  if (!isObjectId(staffId)) throw unavailable("Staff account");
  const key = requireIdempotencyKey(idempotencyKey);
  const hash = fingerprint({ staffId: idText(staffId) });
  const rawToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
  const session = await mongoose.startSession();
  let staff;
  let invitation;
  let created = false;
  try {
    await session.withTransaction(async () => {
      const admin = await administrator(actor, session);
      const replay = await StaffInvitation.findOne({ createdBy: actor, idempotencyKey: key }).select("+idempotencyFingerprint").session(session);
      if (replay) {
        if (replay.idempotencyFingerprint !== hash || idText(replay.user) !== idText(staffId)) throw conflict("staff_invitation_idempotency_conflict", "This idempotency key is associated with a different invitation operation");
        staff = await User.findById(replay.user).session(session);
        invitation = replay;
        return;
      }
      staff = await User.findOne({ _id: staffId, status: "INVITED", role: { $ne: USER_ROLES.CUSTOMER } }).session(session);
      if (!staff) throw unavailable("Staff account");
      assertRoleAuthority(admin, staff.role, staff.role);
      const now = new Date();
      await StaffInvitation.updateMany({ user: staff._id, usedAt: null, revokedAt: null }, { $set: { revokedAt: now, revokedBy: actor } }, { session });
      [invitation] = await StaffInvitation.create([{ user: staff._id, tokenDigest: invitationDigest(rawToken), expiresAt, createdBy: actor, idempotencyKey: key, idempotencyFingerprint: hash }], { session });
      await writeAuditLog(actor, "STAFF_INVITATION_ROTATED", "User", staff._id, { role: staff.role }, session);
      created = true;
    });
    return { created, staff: staffDto(staff), invitation: created ? { token: rawToken, expiresAt: invitation.expiresAt } : { expiresAt: invitation.expiresAt } };
  } finally {
    await session.endSession();
  }
};

export const listStaff = async ({ actor, query }) => {
  await administrator(actor);
  const { page, limit, skip } = pageInput(query);
  const filter = { role: { $ne: USER_ROLES.CUSTOMER } };
  if (query.role && STAFF_ROLES.includes(query.role)) filter.role = { $eq: query.role };
  if (query.status && ["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"].includes(query.status)) filter.status = { $eq: query.status };
  const [items, total] = await Promise.all([User.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit), User.countDocuments(filter)]);
  return { staff: items.map(staffDto), pagination: pagination(page, limit, total) };
};

export const roleRegister = async (actor) => {
  await administrator(actor);
  return { roles: Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => ({ role, permissions: [...permissions], privileged: PRIVILEGED_ROLES.has(role) })) };
};

const mutateStaff = async ({ actor, staffId, expectedVersion, reason, action, role }) => {
  if (!isObjectId(staffId)) throw unavailable("Staff account");
  if (idText(actor) === idText(staffId)) throw conflict("staff_self_administration_forbidden", "Administrators cannot change their own role or account status");
  const session = await mongoose.startSession();
  let staff;
  try {
    await session.withTransaction(async () => {
      const admin = await administrator(actor, session);
      staff = await User.findById(staffId).select("+authVersion +statusReason").session(session);
      if (!staff || staff.role === USER_ROLES.CUSTOMER) throw unavailable("Staff account");
      if (staff.adminVersion !== expectedVersion) throw conflict("staff_version_conflict", "The staff account has changed");
      assertRoleAuthority(admin, role || staff.role, staff.role);
      const now = new Date();
      if (action === "role") {
        if (staff.role === role) throw conflict("staff_role_unchanged", "The staff account already has this role");
        staff.role = role;
        staff.roleChangedAt = now;
      } else if (action === "suspend") {
        if (staff.status !== "ACTIVE") throw conflict("staff_status_transition_invalid", "Only an active staff account can be suspended");
        staff.status = "SUSPENDED";
        staff.statusChangedAt = now;
        staff.statusReason = reason;
      } else if (action === "reactivate") {
        if (staff.status !== "SUSPENDED") throw conflict("staff_status_transition_invalid", "Only a suspended staff account can be reactivated");
        staff.status = "ACTIVE";
        staff.statusChangedAt = now;
        staff.statusReason = reason;
      }
      staff.authVersion += 1;
      staff.adminVersion += 1;
      await staff.save({ session });
      await revokeSessions(staff._id, `staff_${action}_changed`, session);
      const auditAction = action === "role" ? "STAFF_ROLE_CHANGED" : action === "suspend" ? "STAFF_SUSPENDED" : "STAFF_REACTIVATED";
      await writeAuditLog(actor, auditAction, "User", staff._id, action === "role" ? { role, reason } : { reason }, session);
    });
    return staffDto(staff);
  } finally {
    await session.endSession();
  }
};

export const changeRole = (args) => mutateStaff({ ...args, action: "role" });
export const suspendStaff = (args) => mutateStaff({ ...args, action: "suspend" });
export const reactivateStaff = (args) => mutateStaff({ ...args, action: "reactivate" });
