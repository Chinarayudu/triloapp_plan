# Realtime (Socket.IO) event catalogue

Written in response to the Host app team probing for this blind (no `/docs`,
`/api-docs`, or `/swagger.json` exists — Socket.IO events aren't in the
Postman collection either). This is the source of truth going forward;
keep it in sync whenever an event is added, renamed, or its payload
changes. Server code lives in [`src/realtime/socket.ts`](src/realtime/socket.ts)
plus the `emitToUser`/`emitToRoom` call sites listed below.

The HTTP paths referenced below as event triggers are shown bare (`/calls`,
`/live/broadcasts`, `/me/presence`, ...) — the real paths are namespaced
per app, `/user/...` or `/host/...` (see `BACKEND_PLAN.md`'s "API namespaced
per app" note). The socket connection/events themselves aren't affected —
this only changes REST paths, not `io.emit`/room names/event payloads.

## Connecting

```js
io(baseUrl, { auth: (cb) => cb({ token: accessJwt }) })
```

The server validates `handshake.auth.token` at connect time only
(`src/realtime/socket.ts`'s `io.use` middleware) and rejects the handshake
if it's missing/invalid/expired. On success, every socket is auto-joined to
a per-user room named `user:<userId>` — this is how `emitToUser` targets one
account without the server tracking socket ids itself.

**Token expiry mid-connection**: access tokens (`ACCESS_TOKEN_TTL`,
[`src/lib/jwt.ts`](src/lib/jwt.ts)) last **15 minutes**. The server does
**not** re-validate a socket after the initial handshake — a connected
socket keeps working past its token's expiry with no server-initiated
"please refresh" event. A reconnect (Socket.IO's built-in auto-reconnect or
a manual one) re-runs the same auth middleware with whatever token the
client currently has in `auth`, so the client is responsible for keeping
that token fresh (via the refresh-token flow) before it reconnects — the
server gives no signal that a refresh is due.

## Rooms

| Room | Membership | Used for |
|---|---|---|
| `user:<userId>` | every socket for that user, auto-joined on connect | `emitToUser` — all 1:1 events below |
| `live-<broadcastId>` | the host (joined on `POST /live/broadcasts`) + every active viewer (joined on `POST /live/broadcasts/:id/join`) | `emitToRoom` — live chat, live-context gifts, broadcast end |

## Events

| Event | Trigger | Target | Payload |
|---|---|---|---|
| `presence:update` | host toggles `PATCH /me/presence`, or their last socket disconnects (auto-offline) | everyone (`io.emit`) | `{ hostId, isOnline }` |
| `host:busy` | a call is accepted (`isBusy: true`); an ongoing call ends — hang-up by either side, insufficient balance, a party dropping and not reconnecting within `CALL_DISCONNECT_GRACE_MS` (20s), or the stale-call reaper (`isBusy: false`). Ringing calls don't count | everyone (`io.emit`) | `{ hostId, isBusy }` — the initial value is `isBusy` on `GET /hosts` and `GET /hosts/:hostId`; show "Busy" over "Online" while true |
| `call:incoming` | `POST /calls` | the called host | `{ callId, userId, callerName, ratePerMinutePaise, type, mediaProvider }` — `type` is `"video"` or `"voice"` (the Host app opens the camera only for video); `mediaProvider` is `"agora"` or `"p2p"` — what the call starts on; an `"auto"` p2p call can later switch to Agora (`call:media-fallback`) |
| `call:accepted` | `POST /calls/:id/accept` | the calling user | `{ callId, channelName }` |
| `call:signal` | `POST /calls/:id/signal` (p2p calls only) | the *other* participant of that call | `{ callId, fromUserId, data }` — `data` is WebRTC setup, relayed unchanged: `{ type: "hello" }`, `{ type: "offer" \| "answer", sdp }`, or `{ type: "candidate", candidate: RTCIceCandidateInit }`. Handshake: both sides send `hello` when their media is ready; the caller sends the offer only after receiving the host's `hello`; the host replies to the first `hello` it receives with one of its own. See `lib/p2p.js` in either app |
| `call:media-fallback` | `POST /calls/:id/media-fallback` by one participant of an `"auto"` call (its p2p connection couldn't be established) — sent only by the request that actually switched the call | the *other* participant | `{ callId, channelName, mediaProvider: "agora", agoraToken, iceServers: null, agoraFallbackAllowed: true }` — `agoraToken` is minted for the recipient. Leave the p2p session and join Agora with these; ignore it if this app already switched itself |
| `call:ended` | reject / end / ringing-timeout / insufficient-balance / a party lost connection (`endReason: "connection_lost"`) / an admin ended it (`POST /admin/calls/:id/end`, `endReason: "ended_by_admin"`) / stale-call reaper sweep | both parties (or the caller alone for a miss/reject) | `{ callId, status, totalAmountPaise, totalBeans, endReason? }` — there is no separate `call:missed`/`call:declined` event; those cases are `call:ended` with `status: "missed"` / `"rejected"` and an `endReason` |
| `call:low-balance-warning` | mid-call billing tick leaves the user under one tick's cost | the calling user | `{ callId, remainingPaise }` |
| `chat:message` | `POST /chat/messages` (text or photo) — and `POST /gifts/send` with `context: "chat"` (gift) | text/photo: the other participant. gift: **both** participants | text: `{ conversationId, messageId, senderId, type: "text", content, mediaUrl: null, createdAt }`. photo: `{ …, type: "image", content (optional caption, may be ""), mediaUrl }` — `mediaUrl` is a signed GET valid ~1 h; history (`GET /chat/conversations/:id/messages`) always returns a fresh one. gift: `{ conversationId, messageId, senderId, type: "gift", gift: { id, name, iconUrl }, content: "", createdAt }` — same shape as the message in `GET /chat/conversations/:id/messages` |
| `live:host-went-live` | `POST /live/broadcasts` (start) | each follower of the host | `{ hostId, broadcastId }` |
| `live:chat` | `POST /live/broadcasts/:id/chat` | the broadcast room (host + viewers) | `{ broadcastId, senderId, senderName, content, createdAt }` — not persisted; BR-LIVE-02 only requires live visibility, not chat history |
| `live:ended` | `POST /live/broadcasts/:id/end`, or admin force-end | the broadcast room | `{ broadcastId }` |
| `live:media-updated` | `POST /live/broadcasts/:id/sfu/publish` (`"cloudflare"` broadcasts only) — the host published, or republished after a reconnect | the broadcast room | `{ broadcastId }` — viewers re-run `POST .../sfu/subscribe` + `.../sfu/answer` to pull the host's current tracks (also how a viewer who got a 409 "not ready yet" learns it can subscribe now) |
| `gift:received` | `POST /gifts/send` | the recipient host, plus the broadcast room too when `context: "live"` | `{ giftTransactionId, senderId, senderName, gift: { id, name, iconUrl }, beansCredited, context, broadcastId }` — `context` is `"call"` | `"chat"` | `"live"` or `null`; `broadcastId` is set only for a live gift |
| `live:gift` | `POST /gifts/send` with `context: "live"` | the broadcast room (host + every viewer) | `{ broadcastId, senderId, senderName, gift: { id, name, iconUrl }, createdAt }` — for the "Rahul sent a Rose" line in the live comments |
| `gift:requested` | `POST /gifts/request` | the requested user | `{ requestId, hostId, suggestedGiftId, note }` — the request is stored (admin Gift Activity); it becomes accepted when the user next sends that host a gift, declined on `POST /gifts/request/decline` — `note` is the host's optional message (max 140 chars) or `null` |
| `gift:requestDeclined` | `POST /gifts/request/decline` | the declined host | `{ userId, giftId }` (`giftId` is `null` unless the client passed one) |
| `kyc:decision` | `POST /admin/kyc/:userId/decision` | the user whose KYC was decided | `{ status, reason }` (`status` is `"approved"` or `"rejected"`; `reason` is `null` for approvals) |
| `notification:new` | a gift received / withdrawal status change / missed call inserts a row into `notifications` | the notified user | the full inserted notification row: `{ id, userId, type, title, body, read, createdAt }` |
| `host:level-up` | a call billing tick, gift, or paid chat message pushes the host's lifetime-earned beans past the next 1,00,000 threshold (emitted after the transaction commits) | the host who levelled up | `{ level, previousLevel, maxPrices: { voiceRatePerMinutePaise, videoRatePerMinutePaise, messageRatePaise } }` |
| `support:message` | a reply on a support ticket: an admin replies (`POST /admin/support/tickets/:id/messages`), or the support bot answers a few seconds after the owner writes (`POST /me/support/tickets` or `.../:id/messages`) | the host or user who owns the ticket | `{ ticketId, message: { id, sender: "agent" \| "bot", senderName, content, attachments: [{ type: "image", url }], createdAt } }` — `senderName` is the admin's name, or "Support assistant" for the bot. Re-fetch the ticket for its updated `needsAgent` |
| `withdrawal:status` | a withdrawal request changes status (admin decision or payout resolution) | the requesting host | `{ withdrawalId, status }` |
| `account:warning` | admin issues a moderation warning | the warned user | `{ message }` |
| `broadcast:message` | admin's platform-wide broadcast-message tool | everyone (`io.emit`) | `{ id, title, message }` |

Every event above is the full, current inventory — it's generated by
grepping `emitToUser`/`emitToRoom`/`io.emit` call sites, not recalled from
memory, so it won't drift silently out of date the way undocumented events
did before this file existed.
