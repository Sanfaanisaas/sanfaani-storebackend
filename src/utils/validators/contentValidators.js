import { z } from "zod";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "Must be a valid ObjectId");
const locale = z.string().trim().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default("en-NG");
const base = { locale, title: z.string().trim().min(2).max(200), summary: z.string().trim().min(2).max(500), body: z.string().min(3).max(100000) };

export const createContentPageSchema = z.object({ slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), ...base }).strict();
export const createPolicyVersionSchema = z.object({ key: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/), effectiveAt: z.coerce.date(), ...base }).strict();
export const contentIdParamsSchema = z.object({ id: objectId }).strict();
export const publicPageParamsSchema = z.object({ slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).strict();
export const publicPolicyParamsSchema = z.object({ key: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/) }).strict();
export const contentTransitionSchema = z.object({ expectedStateVersion: z.coerce.number().int().min(0) }).strict();
