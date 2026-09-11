import { z } from "zod";
import { OPTIONAL_NOTIFICATION_CATEGORIES } from "../../models/NotificationPreference.js";

const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, "Must be a valid 24-character hex ObjectId");

export const notificationIdParamSchema = z.object({
  id: objectIdSchema,
});

export const updateNotificationPreferencesSchema = z.object({
  optionalCategories: z.record(
    z.string().refine((cat) => OPTIONAL_NOTIFICATION_CATEGORIES.includes(cat), {
      message: "Invalid optional notification category",
    }),
    z.boolean({ required_error: "Preference value must be a boolean" })
  ).optional(),
});

export const getNotificationsQuerySchema = z.object({
  page: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).default(1)).optional(),
  limit: z.preprocess((val) => parseInt(val, 10), z.number().int().min(1).max(50).default(20)).optional(),
});
