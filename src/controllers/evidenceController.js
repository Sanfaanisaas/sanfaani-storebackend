import mongoose from "mongoose";
import Evidence from "../models/Evidence.js";
import Claim from "../models/Claim.js";
import Order from "../models/Order.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import Repair from "../models/Repair.js";
import ReturnRequest from "../models/ReturnRequest.js";
import SupportTicket from "../models/SupportTicket.js";
import ProcurementRequest from "../models/ProcurementRequest.js";
import ProcurementQuotation from "../models/ProcurementQuotation.js";
import ServiceRequest from "../models/ServiceRequest.js";
import { catchAsync } from "../utils/catchAsync.js";
import AppError from "../utils/AppError.js";
import { USER_ROLES } from "../utils/constants.js";
import {
  deleteEvidenceObject,
  generatedObjectKey,
  issueEvidenceDownload,
  putEvidenceObject,
  validateEvidenceFile,
} from "../services/evidenceStorageService.js";
import { queueEvidenceCleanup } from "../services/evidenceCleanupService.js";
import { writeAuditLog } from "../services/auditService.js";
import { capturePolicyAcceptances } from "../services/contentService.js";

const unavailable = () =>
  new AppError("Evidence is unavailable", 404, [
    {
      code: "evidence_unavailable",
      message: "Check the evidence reference and permissions",
    },
  ]);
const forbidden = () =>
  new AppError("You do not have permission to manage this evidence", 403, [
    { code: "forbidden", message: "Your account cannot perform this action" },
  ]);

const DOMAIN_CONFIG = Object.freeze({
  /* 
  order: {
    Model: Order,
    ownerField: "userId",
    purposes: new Set(["order_receipt"]),
    customerPurposes: new Set(["order_receipt"]),
    staff: new Set([
      USER_ROLES.STORE_OPERATOR,
      USER_ROLES.FINANCE_OFFICER,
      USER_ROLES.OPS_MANAGER,
      USER_ROLES.SUPER_ADMIN,
    ]),
  },
  */
  order: {
    Model: Order,
    ownerField: "userId",
    purposes: new Set(["order_receipt", "dispatch", "handover"]),
    customerPurposes: new Set(["order_receipt", "dispatch", "handover"]),
    staff: new Set([
      USER_ROLES.STORE_OPERATOR,
      USER_ROLES.FINANCE_OFFICER,
      USER_ROLES.OPS_MANAGER,
      USER_ROLES.SUPER_ADMIN,
    ]),
  },
  repair: {
    Model: Repair,
    ownerField: "customer",
    purposes: new Set([
      "repair_intake",
      "custody",
      "qc",
      "handover",
      "warranty",
    ]),
    customerPurposes: new Set(["repair_intake", "warranty"]),
    staff: new Set([
      USER_ROLES.STORE_OPERATOR,
      USER_ROLES.TECHNICIAN,
      USER_ROLES.QC_OFFICER,
      USER_ROLES.OPS_MANAGER,
      USER_ROLES.SUPER_ADMIN,
    ]),
  },
  claim: {
    Model: Claim,
    ownerField: "submittedBy",
    purposes: new Set(["warranty"]),
    customerPurposes: new Set(["warranty"]),
    staff: new Set([
      USER_ROLES.SUPPORT_OFFICER,
      USER_ROLES.OPS_MANAGER,
      USER_ROLES.SUPER_ADMIN,
    ]),
  },
  return_request: {
    Model: ReturnRequest,
    ownerField: "owner",
    purposes: new Set(["return"]),
    customerPurposes: new Set(["return"]),
    staff: new Set([
      USER_ROLES.STORE_OPERATOR,
      USER_ROLES.SUPPORT_OFFICER,
      USER_ROLES.OPS_MANAGER,
      USER_ROLES.SUPER_ADMIN,
    ]),
  },
  support_ticket: {
    Model: SupportTicket,
    ownerField: "customer",
    purposes: new Set(["support"]),
    customerPurposes: new Set(["support"]),
    staff: new Set([
      USER_ROLES.SUPPORT_OFFICER,
      USER_ROLES.OPS_MANAGER,
      USER_ROLES.SUPER_ADMIN,
    ]),
  },
  procurement_request: {
    Model: ProcurementRequest,
    ownerField: "customer",
    purposes: new Set(["procurement"]),
    customerPurposes: new Set(["procurement"]),
    staff: new Set([
      USER_ROLES.SALES_ADVISOR,
      USER_ROLES.OPS_MANAGER,
      USER_ROLES.SUPER_ADMIN,
    ]),
  },
  procurement_quotation: {
    Model: ProcurementQuotation,
    ownerField: "customer",
    purposes: new Set(["procurement"]),
    customerPurposes: new Set(),
    staff: new Set([
      USER_ROLES.SALES_ADVISOR,
      USER_ROLES.OPS_MANAGER,
      USER_ROLES.SUPER_ADMIN,
    ]),
  },
  service_request: {
    Model: ServiceRequest,
    ownerField: "customer",
    purposes: new Set(["service"]),
    customerPurposes: new Set(["service"]),
    staff: new Set([
      USER_ROLES.TECHNICIAN,
      USER_ROLES.SALES_ADVISOR,
      USER_ROLES.OPS_MANAGER,
      USER_ROLES.SUPER_ADMIN,
    ]),
  },
  purchase_order: {
    Model: PurchaseOrder,
    ownerField: "createdBy",
    purposes: new Set(["procurement"]),
    customerPurposes: new Set(),
    staff: new Set([
      USER_ROLES.INVENTORY_OFFICER,
      USER_ROLES.OPS_MANAGER,
      USER_ROLES.SUPER_ADMIN,
    ]),
  },
});

const validId = (value) => mongoose.isObjectIdOrHexString(value);
const validatedSubject = (subjectType, subjectId, purpose) => {
  const config = DOMAIN_CONFIG[subjectType];
  if (!config || !validId(subjectId))
    throw new AppError("Invalid evidence subject", 400, [
      {
        code: "evidence_subject_invalid",
        message: "A valid evidence domain and identifier are required",
      },
    ]);
  if (!config.purposes.has(purpose))
    throw new AppError("Invalid evidence category", 400, [
      {
        code: "evidence_category_invalid",
        message: "That category is not valid for this domain",
      },
    ]);
  return config;
};

const staffAllowedForRepair = (subject, purpose, user) => {
  if (
    user.role === USER_ROLES.OPS_MANAGER ||
    user.role === USER_ROLES.SUPER_ADMIN
  )
    return true;
  if (user.role === USER_ROLES.TECHNICIAN)
    return (
      subject.technician?.toString() === user.id &&
      purpose !== "qc" &&
      purpose !== "handover"
    );
  if (user.role === USER_ROLES.QC_OFFICER) return purpose === "qc";
  if (user.role === USER_ROLES.STORE_OPERATOR)
    return ["repair_intake", "custody", "handover"].includes(purpose);
  return false;
};

const assertSubjectAccess = async ({
  subjectType,
  subjectId,
  purpose,
  user,
}) => {
  const config = validatedSubject(subjectType, subjectId, purpose);
  const select =
    subjectType === "repair"
      ? `${config.ownerField} technician`
      : config.ownerField;
  const subject = await config.Model.findById(subjectId).select(select);
  if (!subject) throw unavailable();
  const owner = subject[config.ownerField];
  if (!owner) throw unavailable();
  if (user.role === USER_ROLES.CUSTOMER) {
    if (owner.toString() !== user.id || !config.customerPurposes.has(purpose))
      throw unavailable();
    return { subject, owner };
  }
  const allowed =
    subjectType === "repair"
      ? staffAllowedForRepair(subject, purpose, user)
      : config.staff.has(user.role);
  if (!allowed) throw forbidden();
  return { subject, owner };
};

const findAuthorizedEvidence = async (evidenceId, user) => {
  if (!validId(evidenceId))
    throw new AppError("Invalid evidence identifier", 400, [
      {
        code: "evidence_identifier_invalid",
        message: "A valid evidence identifier is required",
      },
    ]);
  const evidence = await Evidence.findById(evidenceId).select("+objectKey");
  if (!evidence) throw unavailable();
  await assertSubjectAccess({
    subjectType: evidence.subjectType,
    subjectId: evidence.subject,
    purpose: evidence.purpose,
    user,
  });
  return evidence;
};

const responseDto = (evidence) => ({
  id: evidence._id,
  subjectType: evidence.subjectType,
  subjectId: evidence.subject,
  purpose: evidence.purpose,
  displayName: evidence.displayName,
  detectedMimeType: evidence.detectedMimeType,
  size: evidence.size,
  retentionState: evidence.retentionState,
  createdAt: evidence.createdAt,
});

const queueCleanupAfterFailedCompensation = async ({
  taskType,
  evidenceId,
  key,
  actorId,
}) => {
  try {
    await queueEvidenceCleanup({
      taskType,
      evidenceId,
      objectKey: key,
      actorId,
    });
  } catch {
    // The original operational error is preserved. There is intentionally no
    // raw provider diagnostic in an API response or log.
  }
};

export const uploadEvidence = catchAsync(async (req, res) => {
  if (!req.file)
    throw new AppError("Evidence file is required", 400, [
      {
        code: "evidence_file_required",
        message: "Attach one supported evidence file",
      },
    ]);
  const { subjectType, subjectId, purpose } = req.body;
  const { owner } = await assertSubjectAccess({
    subjectType,
    subjectId,
    purpose,
    user: req.user,
  });
  const file = validateEvidenceFile(req.file);
  const key = generatedObjectKey();

  // Object persistence happens before MongoDB. The catch branch compensates
  // explicitly because an external object store cannot join the DB transaction.
  await putEvidenceObject({
    key,
    body: req.file.buffer,
    contentType: file.detectedMimeType,
    checksum: file.checksum,
  });
  const session = await mongoose.startSession();
  try {
    let evidence;
    await session.withTransaction(async () => {
      const policyAcceptances = await capturePolicyAcceptances("evidence", { session });
      [evidence] = await Evidence.create(
        [
          {
            subjectType,
            subject: subjectId,
            owner,
            purpose,
            ...file,
            objectKey: key,
            uploader: req.user.id,
            policyAcceptances,
          },
        ],
        { session },
      );
      await writeAuditLog(
        req.user.id,
        "EVIDENCE_UPLOADED",
        "Evidence",
        evidence._id,
        { subjectType, purpose, size: file.size },
        session,
      );
    });
    res.status(201).json({ success: true, data: responseDto(evidence) });
  } catch (error) {
    try {
      await deleteEvidenceObject(key);
    } catch {
      await queueCleanupAfterFailedCompensation({
        taskType: "DELETE_ORPHAN",
        key,
        actorId: req.user.id,
      });
    }
    throw error;
  } finally {
    await session.endSession();
  }
});

export const downloadEvidence = catchAsync(async (req, res) => {
  const evidence = await findAuthorizedEvidence(req.params.id, req.user);
  if (evidence.retentionState !== "ACTIVE") throw unavailable();
  const access = await issueEvidenceDownload(evidence.objectKey);
  // The URL is returned only after this authorized access is auditable. It is
  // never persisted and audit metadata deliberately excludes it.
  await writeAuditLog(
    req.user.id,
    "EVIDENCE_DOWNLOAD_AUTHORIZED",
    "Evidence",
    evidence._id,
    { subjectType: evidence.subjectType, purpose: evidence.purpose },
  );
  res.json({
    success: true,
    data: { url: access.url, expiresAt: access.expiresAt },
  });
});

export const deleteEvidence = catchAsync(async (req, res) => {
  const evidence = await findAuthorizedEvidence(req.params.id, req.user);
  if (evidence.retentionState === "DELETED")
    return res.json({
      success: true,
      data: { id: evidence._id, deleted: true },
    });
  if (evidence.retentionState === "LEGAL_HOLD")
    throw new AppError("Evidence is retained and cannot be deleted", 409, [
      {
        code: "evidence_legal_hold",
        message: "This evidence is under retention",
      },
    ]);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Evidence.updateOne(
        { _id: evidence._id, retentionState: "ACTIVE" },
        { $set: { retentionState: "DELETE_PENDING" } },
        { session },
      );
      await writeAuditLog(
        req.user.id,
        "EVIDENCE_DELETE_REQUESTED",
        "Evidence",
        evidence._id,
        { subjectType: evidence.subjectType, purpose: evidence.purpose },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  try {
    await deleteEvidenceObject(evidence.objectKey);
  } catch {
    await queueCleanupAfterFailedCompensation({
      taskType: "FINALIZE_DELETION",
      evidenceId: evidence._id,
      key: evidence.objectKey,
      actorId: req.user.id,
    });
    return res.status(202).json({
      success: true,
      data: { id: evidence._id, deleted: false, cleanupPending: true },
    });
  }

  const finalSession = await mongoose.startSession();
  try {
    await finalSession.withTransaction(async () => {
      await Evidence.updateOne(
        { _id: evidence._id, retentionState: "DELETE_PENDING" },
        { $set: { retentionState: "DELETED", deletedAt: new Date() } },
        { session: finalSession },
      );
      await writeAuditLog(
        req.user.id,
        "EVIDENCE_DELETED",
        "Evidence",
        evidence._id,
        { subjectType: evidence.subjectType, purpose: evidence.purpose },
        finalSession,
      );
    });
  } catch (error) {
    await queueCleanupAfterFailedCompensation({
      taskType: "FINALIZE_DELETION",
      evidenceId: evidence._id,
      key: evidence.objectKey,
      actorId: req.user.id,
    });
    throw error;
  } finally {
    await finalSession.endSession();
  }
  res.json({ success: true, data: { id: evidence._id, deleted: true } });
});
