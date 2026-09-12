import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "./notifications.service";

export const notificationsRouter = Router();

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(50).default(20),
});

notificationsRouter.get("/me/notifications", requireAuth, async (req, res, next) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    next(new AppError(400, parsed.error.issues.map((i) => i.message).join(", ")));
    return;
  }

  try {
    const { page, pageSize } = parsed.data;
    res.json(await listNotifications(req.user!.sub, page, pageSize));
  } catch (err) {
    next(err);
  }
});

notificationsRouter.patch("/me/notifications/read-all", requireAuth, async (req, res, next) => {
  try {
    await markAllNotificationsRead(req.user!.sub);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.patch("/me/notifications/:id/read", requireAuth, async (req, res, next) => {
  try {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw new AppError(400, "Invalid notification id");
    await markNotificationRead(req.user!.sub, id.data);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
