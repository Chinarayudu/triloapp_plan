import { Router } from "express";
import { z } from "zod";
import { writeAuditLog } from "../../lib/auditLog";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { requireAdminPermission } from "../admin/permissions";
import {
  AccountRole,
  addAgentMessage,
  addOwnerMessage,
  createTicket,
  getOwnTicketWithMessages,
  getTicketWithMessages,
  listOwnTickets,
  listTicketsForAdmin,
  setTicketStatus,
} from "./support.service";
import { getCurrentBotConfig, listBotConfigs, scheduleBotReply, setBotConfig, SUPPORT_BOT_MODELS } from "./supportBot.service";
import { createArticle, listArticles, updateArticle } from "./supportKb.service";

function parseId(raw: unknown, label: string): string {
  const result = z.string().uuid().safeParse(raw);
  if (!result.success) throw new AppError(400, `Invalid ${label}`);
  return result.data;
}

const contentSchema = z.object({ content: z.string().trim().min(1).max(2000) });

// ---- Host app + User app (mounted under /host and /user) ---------------------
// Same endpoints for both apps; each account only ever sees its own tickets.
// The bot's reply (if it's switched on) arrives afterwards as `support:message`.

export const supportRouter = Router();
const asAccount = [requireAuth, requireRole("host", "user")];

supportRouter.get("/me/support/tickets", ...asAccount, async (req, res, next) => {
  try {
    res.json({ tickets: await listOwnTickets(req.user!.sub) });
  } catch (err) {
    next(err);
  }
});

const createTicketSchema = z.object({
  subject: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(50),
  content: z.string().trim().min(1).max(2000),
});

supportRouter.post("/me/support/tickets", ...asAccount, validateBody(createTicketSchema), async (req, res, next) => {
  try {
    const { subject, category, content } = req.body as z.infer<typeof createTicketSchema>;
    const created = await createTicket(req.user!.sub, req.user!.role as AccountRole, subject, category, content);
    scheduleBotReply(created.ticket.id);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

supportRouter.get("/me/support/tickets/:id", ...asAccount, async (req, res, next) => {
  try {
    res.json(await getOwnTicketWithMessages(req.user!.sub, parseId(req.params.id, "ticket id")));
  } catch (err) {
    next(err);
  }
});

supportRouter.post("/me/support/tickets/:id/messages", ...asAccount, validateBody(contentSchema), async (req, res, next) => {
  try {
    const ticketId = parseId(req.params.id, "ticket id");
    const { content } = req.body as z.infer<typeof contentSchema>;
    const message = await addOwnerMessage(req.user!.sub, req.user!.role as AccountRole, ticketId, content);
    scheduleBotReply(ticketId);
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

// ---- Admin dashboard (mounted once at the root, like adminRouter) ------------
// Support reuses the "moderation" admin permission (account-facing work)
// rather than adding a new permission to the sub-admin system.

export const supportAdminRouter = Router();
const asSupportAdmin = [requireAuth, requireAdminPermission("moderation")];

const ticketListQuery = z.object({
  status: z.enum(["open", "closed"]).optional(),
  // "true" = the queue of tickets the bot handed to a person.
  needsAgent: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

supportAdminRouter.get("/admin/support/tickets", ...asSupportAdmin, async (req, res, next) => {
  try {
    const query = ticketListQuery.safeParse(req.query);
    if (!query.success) throw new AppError(400, "status must be open or closed; needsAgent must be true or false");
    res.json({ tickets: await listTicketsForAdmin(query.data) });
  } catch (err) {
    next(err);
  }
});

supportAdminRouter.get("/admin/support/tickets/:id", ...asSupportAdmin, async (req, res, next) => {
  try {
    res.json(await getTicketWithMessages(parseId(req.params.id, "ticket id")));
  } catch (err) {
    next(err);
  }
});

supportAdminRouter.post("/admin/support/tickets/:id/messages", ...asSupportAdmin, validateBody(contentSchema), async (req, res, next) => {
  try {
    const ticketId = parseId(req.params.id, "ticket id");
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
    const ticketId = parseId(req.params.id, "ticket id");
    const { status } = req.body as z.infer<typeof statusSchema>;
    const ticket = await setTicketStatus(ticketId, status);
    await writeAuditLog(req.user!.sub, `support.${status}`, "support_ticket", ticketId);
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// Bot switch: on/off, which Claude model, and how many replies per ticket
// before a person takes over. `current` is what's active; `configs` the history.
supportAdminRouter.get("/admin/support/bot-config", ...asSupportAdmin, async (_req, res, next) => {
  try {
    res.json({ current: await getCurrentBotConfig(), models: SUPPORT_BOT_MODELS, configs: await listBotConfigs() });
  } catch (err) {
    next(err);
  }
});

const botConfigSchema = z.object({
  enabled: z.boolean(),
  model: z.enum(SUPPORT_BOT_MODELS),
  maxRepliesPerTicket: z.number().int().min(1).max(20),
});

supportAdminRouter.post("/admin/support/bot-config", ...asSupportAdmin, validateBody(botConfigSchema), async (req, res, next) => {
  try {
    res.status(201).json(await setBotConfig(req.user!.sub, req.body as z.infer<typeof botConfigSchema>));
  } catch (err) {
    next(err);
  }
});

// The bot's help library.
supportAdminRouter.get("/admin/support/kb", ...asSupportAdmin, async (_req, res, next) => {
  try {
    res.json({ articles: await listArticles() });
  } catch (err) {
    next(err);
  }
});

const articleFields = {
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(10_000),
  audience: z.enum(["host", "user", "all"]),
};
const articleSchema = z.object({ ...articleFields, active: z.boolean().default(true) });

supportAdminRouter.post("/admin/support/kb", ...asSupportAdmin, validateBody(articleSchema), async (req, res, next) => {
  try {
    const article = await createArticle(req.body as z.infer<typeof articleSchema>);
    await writeAuditLog(req.user!.sub, "support.kb.create", "support_kb_article", article.id);
    res.status(201).json(article);
  } catch (err) {
    next(err);
  }
});

// No default on `active` here — editing a title must not re-activate a switched-off article.
const articlePatchSchema = z
  .object({ ...articleFields, active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

supportAdminRouter.patch("/admin/support/kb/:id", ...asSupportAdmin, validateBody(articlePatchSchema), async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "article id");
    const article = await updateArticle(id, req.body as z.infer<typeof articlePatchSchema>);
    await writeAuditLog(req.user!.sub, "support.kb.update", "support_kb_article", id);
    res.json(article);
  } catch (err) {
    next(err);
  }
});
