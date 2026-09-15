import { z } from "zod";
import { USER_ROLES } from "../constants.js";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "Must be a valid ObjectId");
const staffRoles = Object.values(USER_ROLES).filter((role) => role !== USER_ROLES.CUSTOMER);
const expectedVersion = z.preprocess((value) => Number(value), z.number().int().min(0));

export const staffIdParamsSchema = z.object({ id: objectId }).strict();
export const inviteStaffSchema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(40).optional().nullable(),
  role: z.enum(staffRoles),
}).strict();
export const acceptStaffInvitationSchema = z.object({ password: z.string().min(12).max(128) }).strict();
export const changeStaffRoleSchema = z.object({ expectedVersion, role: z.enum(staffRoles), reason: z.string().trim().min(3).max(500) }).strict();
export const changeStaffStatusSchema = z.object({ expectedVersion, reason: z.string().trim().min(3).max(500) }).strict();
export const staffListQuerySchema = z.object({
  page: z.preprocess((value) => Number(value), z.number().int().min(1).default(1)).optional(),
  limit: z.preprocess((value) => Number(value), z.number().int().min(1).max(50).default(20)).optional(),
  role: z.enum(staffRoles).optional(),
  status: z.enum(["INVITED", "ACTIVE", "SUSPENDED", "DISABLED"]).optional(),
}).strict();
