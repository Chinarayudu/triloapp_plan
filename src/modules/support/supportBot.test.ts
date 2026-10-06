import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app";
import { env } from "../../config/env";
import { registerAndLogin, registerAndLoginAdmin, stubFetch } from "../../test/helpers";
import { replyAsBot } from "./supportBot.service";

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// The bot switch is global and the test DB is shared by every test file — always switch it back off.
const BOT_OFF = { enabled: false, model: "claude-haiku-4-5", maxRepliesPerTicket: 6 };

// Messages API response shapes, as the Anthropic SDK expects them.
function toolUse(name: string, input: object) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: `toolu_${name}`, name, input }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}
function answer(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

type ClaudeRequest = {
  model: string;
  output_config?: unknown;
  system: { text: string }[];
  tools: { name: string }[];
  messages: { role: string; content: unknown }[];
};

describe("Support bot", () => {
  const savedKey = env.ANTHROPIC_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    env.ANTHROPIC_API_KEY = savedKey;
  });

  it("answers a host's ticket from the help library and a read-only account lookup", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();
    const host = await registerAndLogin(app, "host");
    const setBot = (body: object) => request(app).post("/admin/support/bot-config").set(bearer(admin.accessToken)).send(body);

    env.ANTHROPIC_API_KEY = "test-key";
    const replies = [toolUse("get_my_withdrawals", {}), answer("You have no withdrawal requests yet.")];
    const sent = stubFetch(() => replies.shift());

    try {
      const article = await request(app)
        .post("/admin/support/kb")
        .set(bearer(admin.accessToken))
        .send({ title: "Withdrawal timing", content: "Approved withdrawals reach the bank within 2 working days.", audience: "host" });
      expect(article.status).toBe(201);
      expect((await setBot({ enabled: true, model: "claude-haiku-4-5", maxRepliesPerTicket: 2 })).status).toBe(201);

      const created = await request(app)
        .post("/host/me/support/tickets")
        .set(bearer(host.accessToken))
        .send({ subject: "Payout", category: "withdrawals", content: "Where is my withdrawal?" });
      const ticketId = created.body.ticket.id as string;

      const thread = () => request(app).get(`/host/me/support/tickets/${ticketId}`).set(bearer(host.accessToken));
      await vi.waitFor(async () => expect((await thread()).body.messages).toHaveLength(2));
      const messages = (await thread()).body.messages;
      expect(messages[1]).toMatchObject({ sender: "bot", senderName: "Support assistant", content: "You have no withdrawal requests yet." });

      const first = sent[0].body as ClaudeRequest;
      expect(sent[0].url).toBe("https://api.anthropic.com/v1/messages");
      expect(first.model).toBe("claude-haiku-4-5");
      expect(first.output_config).toBeUndefined(); // Haiku rejects effort
      expect(first.system[0].text).toContain("Host app");
      expect(first.system[0].text).toContain("Approved withdrawals reach the bank within 2 working days.");
      expect(first.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["get_my_withdrawals", "get_my_kyc_status", "handoff_to_human"]),
      );
      expect(first.tools.map((t) => t.name)).not.toContain("get_my_wallet_balance"); // user-only lookup
      expect(first.messages[0]).toEqual({
        role: "user",
        content: "Ticket subject: Payout\nCategory: withdrawals\n\nWhere is my withdrawal?",
      });
      // The lookup's result went back to the model.
      const second = sent[1].body as ClaudeRequest;
      expect(second.messages[2]).toEqual({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_get_my_withdrawals", content: "[]" }],
      });

      // Reply #2 of the 2 allowed.
      replies.push(answer("Withdrawals take up to 2 working days."));
      await request(app).post(`/host/me/support/tickets/${ticketId}/messages`).set(bearer(host.accessToken)).send({ content: "How long?" });
      await vi.waitFor(async () => expect((await thread()).body.messages).toHaveLength(4));

      // Over the per-ticket limit: no model call, the ticket goes to a person.
      const callsBefore = sent.length;
      await request(app).post(`/host/me/support/tickets/${ticketId}/messages`).set(bearer(host.accessToken)).send({ content: "Still waiting" });
      await vi.waitFor(async () => expect((await thread()).body.messages).toHaveLength(6));
      const after = await thread();
      expect(after.body.messages[5].content).toBe("I've passed this to our support team. Someone will reply here soon.");
      expect(after.body.ticket).toMatchObject({ needsAgent: true, handoffReason: "Reached the assistant's reply limit for one ticket" });
      expect(sent.length).toBe(callsBefore);
    } finally {
      await setBot(BOT_OFF);
    }
  });

  it("hands a user's refund request to a person, then stays silent once an agent takes over", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();
    const user = await registerAndLogin(app, "user");
    const setBot = (body: object) => request(app).post("/admin/support/bot-config").set(bearer(admin.accessToken)).send(body);

    env.ANTHROPIC_API_KEY = "test-key";
    const replies = [toolUse("handoff_to_human", { reason: "Refund request" }), answer("I've asked our team to look at your refund.")];
    const sent = stubFetch(() => replies.shift());

    try {
      await setBot({ enabled: true, model: "claude-sonnet-5-5", maxRepliesPerTicket: 6 });
      const created = await request(app)
        .post("/user/me/support/tickets")
        .set(bearer(user.accessToken))
        .send({ subject: "Refund", category: "payments", content: "I want my money back for yesterday's call" });
      expect(created.status).toBe(201);
      expect(created.body.messages[0].sender).toBe("user");
      const ticketId = created.body.ticket.id as string;
      const thread = () => request(app).get(`/user/me/support/tickets/${ticketId}`).set(bearer(user.accessToken));

      await vi.waitFor(async () => expect((await thread()).body.messages).toHaveLength(2));
      const handedOff = await thread();
      expect(handedOff.body.messages[1]).toMatchObject({ sender: "bot", content: "I've asked our team to look at your refund." });
      expect(handedOff.body.ticket).toMatchObject({ needsAgent: true, handoffReason: "Refund request" });

      const first = sent[0].body as ClaudeRequest;
      expect(first.model).toBe("claude-sonnet-5-5");
      expect(first.output_config).toEqual({ effort: "low" });
      expect(first.system[0].text).toContain("User app");
      expect(first.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["get_my_wallet_balance", "get_my_recharges", "handoff_to_human"]),
      );

      const queue = await request(app).get("/admin/support/tickets?needsAgent=true").set(bearer(admin.accessToken));
      const queued = queue.body.tickets.find((t: { ticket: { id: string } }) => t.ticket.id === ticketId);
      expect(queued.account).toMatchObject({ id: user.user.id, role: "user" });

      // Waiting for a person: the bot doesn't answer.
      const callsBefore = sent.length;
      await request(app).post(`/user/me/support/tickets/${ticketId}/messages`).set(bearer(user.accessToken)).send({ content: "Hello?" });
      await replyAsBot(ticketId);
      expect(sent.length).toBe(callsBefore);

      // An agent takes over: the queue flag clears, and the bot stays out of this ticket for good.
      await request(app).post(`/admin/support/tickets/${ticketId}/messages`).set(bearer(admin.accessToken)).send({ content: "Refunding now" });
      await request(app).post(`/user/me/support/tickets/${ticketId}/messages`).set(bearer(user.accessToken)).send({ content: "Thanks" });
      await replyAsBot(ticketId);
      expect(sent.length).toBe(callsBefore);
      const final = await thread();
      expect(final.body.ticket.needsAgent).toBe(false);
      expect(final.body.messages.map((m: { sender: string }) => m.sender)).toEqual(["user", "bot", "user", "agent", "user"]);
    } finally {
      await setBot(BOT_OFF);
    }
  });

  it("does nothing while switched off, and hands the ticket to a person if the API call fails", async () => {
    const app = createApp();
    const admin = await registerAndLoginAdmin();
    const host = await registerAndLogin(app, "host");
    const setBot = (body: object) => request(app).post("/admin/support/bot-config").set(bearer(admin.accessToken)).send(body);

    env.ANTHROPIC_API_KEY = "test-key";
    const sent = stubFetch(() => ({ type: "error" })); // not a message — the reply can't be read

    try {
      await setBot(BOT_OFF);
      const off = await request(app)
        .post("/host/me/support/tickets")
        .set(bearer(host.accessToken))
        .send({ subject: "Hi", category: "other", content: "Hello" });
      await replyAsBot(off.body.ticket.id);
      expect(sent).toHaveLength(0);

      await setBot({ enabled: true, model: "claude-haiku-4-5", maxRepliesPerTicket: 6 });
      const broken = await request(app)
        .post("/host/me/support/tickets")
        .set(bearer(host.accessToken))
        .send({ subject: "KYC", category: "kyc", content: "Is my KYC approved?" });
      const ticketId = broken.body.ticket.id as string;
      await vi.waitFor(async () => {
        const thread = await request(app).get(`/host/me/support/tickets/${ticketId}`).set(bearer(host.accessToken));
        expect(thread.body.ticket).toMatchObject({ needsAgent: true, handoffReason: "The assistant hit an error" });
      });
    } finally {
      await setBot(BOT_OFF);
    }
  });

  it("lets moderation admins edit the help library without re-activating switched-off articles", async () => {
    const app = createApp();
    const moderator = await registerAndLoginAdmin("sub_admin", ["moderation"]);
    const finance = await registerAndLoginAdmin("sub_admin", ["finance"]);

    const created = await request(app)
      .post("/admin/support/kb")
      .set(bearer(moderator.accessToken))
      .send({ title: "Beans", content: "1 bean = ₹1", audience: "all", active: false });
    expect(created.body.active).toBe(false);
    const renamed = await request(app)
      .patch(`/admin/support/kb/${created.body.id}`)
      .set(bearer(moderator.accessToken))
      .send({ title: "What are beans?" });
    expect(renamed.body).toMatchObject({ title: "What are beans?", active: false });

    expect((await request(app).get("/admin/support/kb").set(bearer(finance.accessToken))).status).toBe(403);
    const badModel = await request(app)
      .post("/admin/support/bot-config")
      .set(bearer(moderator.accessToken))
      .send({ enabled: true, model: "gpt-4", maxRepliesPerTicket: 6 });
    expect(badModel.status).toBe(400);
  });
});
