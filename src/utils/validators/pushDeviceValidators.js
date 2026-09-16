import { z } from "zod";

const objectId = z.string().regex(/^[a-fA-F0-9]{24}$/, "Must be a valid ObjectId");

export const registerPushDeviceSchema = z.object({
  deviceId: z.string().trim().min(8).max(256),
  pushToken: z.string().trim().min(8).max(4096),
  platform: z.enum(["ios", "android", "web"]),
  label: z.string().trim().min(1).max(120),
}).strict();
export const pushDeviceParamsSchema = z.object({ id: objectId }).strict();
