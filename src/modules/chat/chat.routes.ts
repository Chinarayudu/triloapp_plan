import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { sendPushNotification } from "../../lib/push";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { emitToUser, isUserConnected } from "../../realtime/socket";
import {
  findOrCreateConversation,
  getConversationById,
  listConversations,
  listMessages,
  otherParticipantId,
  sendMessage,
} from "./chat.service";

export const chatRouter = Router();

const sendMessageSchema = z.object({
  recipientId: z.string().uuid(),
  content: z.string().min(1).max(2000),
});

chatRouter.post("/chat/messages", requireAuth, validateBody(sendMessageSchema), async (req, res, next) => {
  try {
    const { recipientId, content } = req.body as z.infer<typeof sendMessageSchema>;
    const senderId = req.user!.sub;
    const senderRole = req.user!.role as "user" | "host";

    const conversation = await findOrCreateConversation(senderId, senderRole, recipientId);
    const message = await sendMessage(conversation.id, senderId, content);

    const payload = {
      conversationId: conversation.id,
      messageId: message.id,
      senderId,
      content: message.content,
      createdAt: message.createdAt,
    };
    emitToUser(recipientId, "chat:message", payload);

    if (!(await isUserConnected(recipientId))) {
      void sendPushNotification(recipientId, "New message", content.slice(0, 100));
    }

    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
});

chatRouter.get("/chat/conversations", requireAuth, async (req, res, next) => {
  try {
    const conversations = await listConversations(req.user!.sub);
    res.json({ conversations });
  } catch (err) {
    next(err);
  }
});

const listMessagesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
});

chatRouter.get("/chat/conversations/:id/messages", requireAuth, async (req, res, next) => {
  const parsedQuery = listMessagesQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    next(new AppError(400, parsedQuery.error.issues.map((i) => i.message).join(", ")));
    return;
  }

  try {
    const conversation = await getConversationById(String(req.params.id));
    if (!conversation) throw new AppError(404, "Conversation not found");
    if (conversation.userId !== req.user!.sub && conversation.hostId !== req.user!.sub) {
      throw new AppError(403, "Not your conversation");
    }

    const { page, pageSize } = parsedQuery.data;
    const messages = await listMessages(conversation.id, page, pageSize);
    res.json({
      conversationId: conversation.id,
      otherParticipantId: otherParticipantId(conversation, req.user!.sub),
      messages,
      page,
      pageSize,
    });
  } catch (err) {
    next(err);
  }
});
