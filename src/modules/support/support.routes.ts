import { Router } from "express";
import { z } from "zod";
import { writeAuditLog } from "../../lib/auditLog";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { requireAdminPermission } from "../admin/permissions";
import {
  addAgentMessage,
  addHostMessage,
  createTicket,
  getOwnTicketWithMessages,
  getTicketWithMessages,
  listHostTickets,
  listTicketsForAdmin,
  setTicketStatus,
} from "./support.service";

function parseTicketId(raw: unknown): string {
  const result = z.string().uuid().safeParse(raw);
  if (!result.success) throw new AppError(400, "Invalid ticket id");
  return result.data;
}

const contentSchema = z.object({ content: z.string().trim().min(1).max(2000) });

// ---- Host app (mounted under /host, like every per-app router) ---------------

export const supportRouter = Router();

supportRouter.get("/me/support/tickets", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    res.json({ tickets: await listHostTickets(req.user!.sub) });
  } catch (err) {
    next(err);
  }
});

const createTicketSchema = z.object({
  subject: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(50),
  content: z.string().trim().min(1).max(2000),
});

supportRouter.post("/me/support/tickets", requireAuth, requireRole("host"), validateBody(createTicketSchema), async (req, res, next) => {
  try {
    const { subject, category, content } = req.body as z.infer<typeof createTicketSchema>;
    res.status(201).json(await createTicket(req.user!.sub, subject, category, content));
  } catch (err) {
    next(err);
  }
});

supportRouter.get("/me/support/tickets/:id", requireAuth, requireRole("host"), async (req, res, next) => {
  try {
    res.json(await getOwnTicketWithMessages(req.user!.sub, parseTicketId(req.params.id)));
  } catch (err) {
    next(err);
  }
});

supportRouter.post(
  "/me/support/tickets/:id/messages",
  requireAuth,
  requireRole("host"),
  validateBody(contentSchema),
  async (req, res, next) => {
    try {
      const { content } = req.body as z.infer<typeof contentSchema>;
      res.status(201).json(await addHostMessage(req.user!.sub, parseTicketId(req.params.id), content));
    } catch (err) {
      next(err);
    }
  },
);

// ---- Admin dashboard (mounted once at the root, like adminRouter) ------------
// Support reuses the "moderation" admin permission (account-facing work)
// rather than adding a new permission to the sub-admin system.

export const supportAdminRouter = Router();
const asSupportAdmin = [requireAuth, requireAdminPermission("moderation")];

const statusQuery = z.enum(["open", "closed"]).optional();

supportAdminRouter.get("/admin/support/tickets", ...asSupportAdmin, async (req, res, next) => {
  try {
    const status = statusQuery.safeParse(req.query.status);
    if (!status.success) throw new AppError(400, "status must be open or closed");
    res.json({ tickets: await listTicketsForAdmin(status.data) });
  } catch (err) {
    next(err);
  }
});

supportAdminRouter.get("/admin/support/tickets/:id", ...asSupportAdmin, async (req, res, next) => {
  try {
    res.json(await getTicketWithMessages(parseTicketId(req.params.id)));
  } catch (err) {
    next(err);
  }
});

supportAdminRouter.post("/admin/support/tickets/:id/messages", ...asSupportAdmin, validateBody(contentSchema), async (req, res, next) => {
  try {
    const ticketId = parseTicketId(req.params.id);
    const { content } = req.body as z.infer<typeof contentSchema>;
    const message = await addAgentMessage(req.user!.sub, ticketId, content);
    await writeAuditLog(req.user!.sub, "support.reply", "support_ticket", ticketId);
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

const statusSchema = z.object({ status: z.enum(["open", "closed"]) });

supportAdminRouter.patch("/admin/support/tickets/:id", ...asSupportAdmin, validateBody(statusSchema), async (req, res, next) => {
  try {
    const ticketId = parseTicketId(req.params.id);
    const { status } = req.body as z.infer<typeof statusSchema>;
    const ticket = await setTicketStatus(ticketId, status);
    await writeAuditLog(req.user!.sub, `support.${status}`, "support_ticket", ticketId);
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});
