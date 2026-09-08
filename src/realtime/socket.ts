import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { verifyAccessToken } from "../lib/jwt";
import { logger } from "../lib/logger";

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
    socket.join(`user:${socket.data.user.sub}`);
    logger.debug({ userId: socket.data.user?.sub }, "socket connected");
  });

  return io;
}

export function broadcastPresence(hostId: string, isOnline: boolean): void {
  io?.emit("presence:update", { hostId, isOnline });
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
