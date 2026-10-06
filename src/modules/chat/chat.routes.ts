import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { sendPushNotification } from "../../lib/push";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { emitToUser, isUserConnected } from "../../realtime/socket";
import {
  chatMediaUrl,
  findOrCreateConversation,
  issueChatUploadUrl,
  verifyChatImage,
  getConversationById,
  listConversations,
  listMessages,
  otherParticipantId,
  sendMessage,
  sendPaidUserMessage,
} from "./chat.service";

export const chatRouter = Router();

// type defaults to "text" so older app builds keep working. A photo
// ("image") carries the mediaKey from POST /chat/attachments/upload-url, and
// its content (an optional caption) may be empty.
const sendMessageSchema = z
  .object({
    recipientId: z.string().uuid(),
    type: z.enum(["text", "image"]).default("text"),
    content: z.string().max(2000).default(""),
    mediaKey: z.string().min(1).max(300).optional(),
  })
  .refine((m) => (m.type === "text" ? m.content.length > 0 : Boolean(m.mediaKey)), {
    message: "A text message needs content; a photo needs mediaKey",
  });

const uploadUrlSchema = z.object({ recipientId: z.string().uuid(), contentType: z.string().min(1).max(100) });

chatRouter.post("/chat/attachments/upload-url", requireAuth, validateBody(uploadUrlSchema), async (req, res, next) => {
  try {
    const { recipientId, contentType } = req.body as z.infer<typeof uploadUrlSchema>;
    res.status(201).json(await issueChatUploadUrl(req.user!.sub, req.user!.role as "user" | "host", recipientId, contentType));
  } catch (err) {
    next(err);
  }
});

chatRouter.post("/chat/messages", requireAuth, validateBody(sendMessageSchema), async (req, res, next) => {
  try {
    const { recipientId, type, content, mediaKey } = req.body as z.infer<typeof sendMessageSchema>;
    const senderId = req.user!.sub;
    const senderRole = req.user!.role as "user" | "host";

    const conversation = await findOrCreateConversation(senderId, senderRole, recipientId);
    const photoKey = type === "image" ? mediaKey! : null;
    if (photoKey) await verifyChatImage(conversation, senderId, senderRole, photoKey);
    // Users pay per message to a host (host levels); hosts message users free.
    let message;
    let userBalanceAfterPaise: number | null = null;
    if (senderRole === "user") {
      const paid = await sendPaidUserMessage(conversation, content, photoKey);
      message = paid.message;
      userBalanceAfterPaise = paid.userBalanceAfterPaise;
    } else {
      message = await sendMessage(conversation.id, senderId, content, photoKey);
    }

    const payload = {
      conversationId: conversation.id,
      messageId: message.id,
      senderId,
      type: message.type,
      content: message.content,
      mediaUrl: await chatMediaUrl(message),
      createdAt: message.createdAt,
    };
    emitToUser(recipientId, "chat:message", payload);

    if (!(await isUserConnected(recipientId))) {
      void sendPushNotification(recipientId, "New message", photoKey ? "📷 Photo" : content.slice(0, 100));
    }

    // chargedPaise/userBalanceAfterPaise go to the sender only — the host's
    // chat:message event never reveals what the user paid.
    res.status(201).json({ ...payload, chargedPaise: message.chargedPaise, userBalanceAfterPaise });
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
