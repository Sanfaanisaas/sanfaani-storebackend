import { z } from "zod";
export const analyticsEventSchema = z.object({ event: z.string().trim().min(1).max(64), anonymousId: z.string().trim().min(8).max(256), consent: z.boolean().optional(), properties: z.record(z.string().max(64), z.string().max(500)).default({}) }).strict();
export const analyticsQuerySchema = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).strict();
