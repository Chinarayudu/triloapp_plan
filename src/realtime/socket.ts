import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { env } from "../config/env";
import { verifyAccessToken } from "../lib/jwt";
import { logger } from "../lib/logger";
import { isOnline as isHostMarkedOnline, setOffline as setHostOffline } from "../modules/hosts/presence.store";
import { endActiveBroadcastForHostIfAny, liveRoomName } from "../modules/live/live.service";

// Module-level singleton, same shape as db/client.ts's `pool`/`db` exports —
// one Socket.io server per process, created once at startup, read from
// wherever a broadcast needs to happen.
let io: SocketIOServer | undefined;

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, { cors: { origin: "*" } });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string") {
      next(new Error("Missing auth token"));
      return;
    }
    try {
      socket.data.user = verifyAccessToken(token);
      next();
    } catch {
      next(new Error("Invalid or expired access token"));
    }
  });

  io.on("connection", (socket) => {
    // Every socket joins a room named after its own user id, so a call
    // notification (or any future per-user event) can be targeted at
    // exactly one account without the server tracking socket ids itself —
    // Socket.io's room membership does that bookkeeping for us.
    const userId = socket.data.user.sub;
    socket.join(`user:${userId}`);
    logger.debug({ userId }, "socket connected");

    // A host's "online" flag (presence.store.ts) is only ever set/cleared by
    // the explicit PATCH /me/presence toggle — nothing previously corrected
    // it when their connection just dropped (closed tab, backgrounded app,
    // network loss) without them toggling offline first. That left them
    // "online" indefinitely: initiateCall's isOnline() check would keep
    // passing, a caller's ringing call would get created, emitToUser would
    // silently reach no one (no live socket), and the push fallback is a
    // dev-mode log line, not a real notification (lib/push.ts) — so the
    // call rang into the void with no visible failure to either side.
    // Auto-clearing it here (once no other tab/session for this account is
    // still connected) makes initiateCall's check fail fast and honestly
    // ("Host is not online") instead of that silent no-op.
    socket.on("disconnect", async () => {
      logger.debug({ userId }, "socket disconnected");
      if (isHostMarkedOnline(userId) && !(await isUserConnected(userId))) {
        setHostOffline(userId);
        broadcastPresence(userId, false);
      }

      // Ending a live broadcast is far more disruptive to active viewers
      // than the presence flag above (kicks everyone out, not just a status
      // dot flicker), so recovering from a dropped host connection isn't
      // instant — env.LIVE_BROADCAST_DISCONNECT_GRACE_MS is how long a
      // reconnect (page reload, brief network hiccup) has to land before
      // checkAbandonedBroadcast treats the broadcast as genuinely abandoned.
      setTimeout(() => {
        void checkAbandonedBroadcast(userId).catch((err) =>
          logger.error({ err, userId }, "Auto-end-broadcast-on-disconnect check failed"),
        );
      }, env.LIVE_BROADCAST_DISCONNECT_GRACE_MS).unref();
    });
  });

  return io;
}

// A host's live_broadcasts row (live.service.ts's startBroadcast) is only
// ever cleared by an explicit POST .../end — nothing previously corrected
// it when their connection just dropped without one, so an abandoned
// broadcast stayed "live" forever, permanently blocking every future
// attempt to start a new one ("You already have a live broadcast running")
// with no way back except an admin's force-end. Exported (not inlined in
// the disconnect handler above) specifically so a test can call it directly
// instead of waiting on a real disconnect + the real grace-period timer.
export async function checkAbandonedBroadcast(hostId: string): Promise<void> {
  if (await isUserConnected(hostId)) return;
  const ended = await endActiveBroadcastForHostIfAny(hostId);
  if (ended) {
    emitToRoom(liveRoomName(ended.id), "live:ended", { broadcastId: ended.id });
    logger.warn({ hostId, broadcastId: ended.id }, "Auto-ended a live broadcast — host's connection never reconnected");
  }
}

export function broadcastPresence(hostId: string, isOnline: boolean): void {
  io?.emit("presence:update", { hostId, isOnline });
}

// Separate from presence:update rather than a new field on it, so existing
// listeners (Host/Admin apps) keep receiving the exact payload they expect.
// "Busy" = the host has an ongoing (accepted) call — ringing doesn't count.
export function broadcastBusy(hostId: string, isBusy: boolean): void {
  io?.emit("host:busy", { hostId, isBusy });
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(`user:${userId}`).emit(event, payload);
}

// Used to decide whether a chat message needs a push notification
// (chat.service.ts) — "offline" here specifically means "no live socket
// connection right now," not account status.
export async function isUserConnected(userId: string): Promise<boolean> {
  if (!io) return false;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  return sockets.length > 0;
}

// Live broadcasting needs a many-to-one fan-out room (a chat message or
// gift should reach every current viewer, not one targeted user) — these
// three helpers are the only new primitive Phase 7 needed on top of the
// per-user rooms everything else uses. Room membership is driven entirely
// server-side from REST actions (join/leave broadcast), not by the client
// emitting its own socket events, so there's one source of truth for who's
// "in" a broadcast: the live_viewers table, not socket state.
export async function joinUserToRoom(userId: string, room: string): Promise<void> {
  if (!io) return;
  await io.in(`user:${userId}`).socketsJoin(room);
}

export async function leaveUserFromRoom(userId: string, room: string): Promise<void> {
  if (!io) return;
  await io.in(`user:${userId}`).socketsLeave(room);
}

export function emitToRoom(room: string, event: string, payload: unknown): void {
  io?.to(room).emit(event, payload);
}

// Called when admin suspends/bans an account (BR-ACC-05: "in-progress
// sessions terminated, not just blocked from new logins") — forces every
// live connection for this user to drop immediately, on top of revoking
// their refresh tokens (token.service.ts) so they can't silently reconnect
// with a fresh pair. The already-issued access token (up to 15m TTL) still
// works for plain REST calls until it expires; there is no cheaper way to
// invalidate that without a per-request DB check on every route.
export async function disconnectUser(userId: string): Promise<void> {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const socket of sockets) socket.disconnect(true);
}
