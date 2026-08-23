import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { sendPushNotification } from "../../lib/push";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { emitToRoom, emitToUser, isUserConnected } from "../../realtime/socket";
import { getUserById } from "../users/users.service";
import { liveRoomName } from "../live/live.service";
import { listActiveGifts, sendGift } from "./gifts.service";

export const giftsRouter = Router();

giftsRouter.get("/gifts", requireAuth, async (_req, res, next) => {
  try {
    const catalog = await listActiveGifts();
    res.json({ gifts: catalog });
  } catch (err) {
    next(err);
  }
});

const sendGiftSchema = z.object({
  recipientId: z.string().uuid(),
  giftId: z.string().uuid(),
  context: z.enum(["call", "chat", "live"]).optional(),
  contextId: z.string().uuid().optional(),
});

giftsRouter.post("/gifts/send", requireAuth, requireRole("user"), validateBody(sendGiftSchema), async (req, res, next) => {
  try {
    const { recipientId, giftId, context, contextId } = req.body as z.infer<typeof sendGiftSchema>;
    const result = await sendGift(req.user!.sub, recipientId, giftId, context, contextId);

    const giftReceivedPayload = {
      giftTransactionId: result.id,
      senderId: req.user!.sub,
      gift: { id: result.gift.id, name: result.gift.name, iconUrl: result.gift.iconUrl },
      beansCredited: result.beansCredited,
    };
    emitToUser(recipientId, "gift:received", giftReceivedPayload);

    // Live gifts are meant to be seen by everyone watching, not just the
    // host — the same event, additionally fanned out to the broadcast
    // room (BACKEND_PLAN.md §4: "reuses the exact same gifting pipeline").
    if (context === "live" && contextId) {
      emitToRoom(liveRoomName(contextId), "gift:received", giftReceivedPayload);
    }

    res.status(201).json({
      giftTransactionId: result.id,
      gift: { id: result.gift.id, name: result.gift.name, pricePaise: result.gift.pricePaise },
      beansCredited: result.beansCredited,
    });
  } catch (err) {
    next(err);
  }
});

const requestGiftSchema = z.object({
  userId: z.string().uuid(),
  suggestedGiftId: z.string().uuid().optional(),
});

giftsRouter.post(
  "/gifts/request",
  requireAuth,
  requireRole("host"),
  validateBody(requestGiftSchema),
  async (req, res, next) => {
    try {
      const { userId, suggestedGiftId } = req.body as z.infer<typeof requestGiftSchema>;
      const user = await getUserById(userId);
      if (!user || user.role !== "user" || user.status !== "active") {
        throw new AppError(400, "Target must be an active user");
      }

      // This never moves money by itself — it's purely a prompt for the
      // user's client to open the gift picker (BACKEND_PLAN.md §1).
      const payload = { hostId: req.user!.sub, suggestedGiftId: suggestedGiftId ?? null };
      emitToUser(userId, "gift:requested", payload);

      if (!(await isUserConnected(userId))) {
        void sendPushNotification(userId, "Gift request", "A host is asking you for a gift");
      }

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);
