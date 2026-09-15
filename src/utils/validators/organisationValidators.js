import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "A valid identifier is required");

export const organisationIdParamSchema = z.object({ id: objectId });

export const createOrganisationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  type: z.enum(["business", "school", "nonprofit", "government", "other"]),
  billingEmail: z.string().trim().email().max(254),
});

export const organisationMemberSchema = z.object({
  userId: objectId,
  role: z.enum(["OWNER", "ADMIN", "BUYER", "VIEWER"]),
});
