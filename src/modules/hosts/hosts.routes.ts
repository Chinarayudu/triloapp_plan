import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { broadcastPresence } from "../../realtime/socket";
import { followHost, listFollowedHosts, unfollowHost } from "./follow.service";
import { listHosts, HostListSort } from "./hosts.service";
import { setOffline, setOnline } from "./presence.store";

export const hostsRouter = Router();

const hostIdParamSchema = z.string().uuid();
function parseHostId(raw: unknown): string {
  const result = hostIdParamSchema.safeParse(raw);
  if (!result.success) throw new AppError(400, "Invalid host id");
  return result.data;
}

const listQuerySchema = z.object({
  onlineOnly: z.enum(["true", "false"]).optional(),
  sort: z.enum(["rate_asc", "rate_desc", "online_first"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(50).default(20),
});

hostsRouter.get("/hosts", requireAuth, async (req, res, next) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    next(new AppError(400, parsed.error.issues.map((i) => i.message).join(", ")));
    return;
  }

  try {
    const { onlineOnly, sort, page, pageSize } = parsed.data;
    const result = await listHosts({ onlineOnly: onlineOnly === "true", sort: sort as HostListSort | undefined, page, pageSize });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const presenceSchema = z.object({ isOnline: z.boolean() });

hostsRouter.patch(
  "/me/presence",
  requireAuth,
  requireRole("host"),
  validateBody(presenceSchema),
  (req, res, next) => {
    try {
      const { isOnline } = req.body as z.infer<typeof presenceSchema>;
      const hostId = req.user!.sub;

      if (isOnline) setOnline(hostId);
      else setOffline(hostId);

      broadcastPresence(hostId, isOnline);
      res.json({ isOnline });
    } catch (err) {
      next(err);
    }
  },
);

// BR-NOTIF-01's "a followed/favorite host going live" — USER only, a host
// following another host isn't a case this platform needs.
hostsRouter.post("/hosts/:hostId/follow", requireAuth, requireRole("user"), async (req, res, next) => {
  try {
    await followHost(req.user!.sub, parseHostId(req.params.hostId));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

hostsRouter.post("/hosts/:hostId/unfollow", requireAuth, requireRole("user"), async (req, res, next) => {
  try {
    await unfollowHost(req.user!.sub, parseHostId(req.params.hostId));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

hostsRouter.get("/me/following", requireAuth, requireRole("user"), async (req, res, next) => {
  try {
    res.json({ hosts: await listFollowedHosts(req.user!.sub) });
  } catch (err) {
    next(err);
  }
});
