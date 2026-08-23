import { describe, expect, it } from "vitest";
import { generateAgoraToken } from "./agoraToken";

describe("generateAgoraToken", () => {
  it("produces a real, well-formed Agora RTC token when credentials are configured", () => {
    const token = generateAgoraToken("call-test-channel", "8e946734-1b08-4956-b4e1-bb96ddea0135");

    // "007" is Agora's dynamic-key version prefix — a real token, not the
    // "stub-agora-token:" fallback used when Agora isn't configured.
    expect(token.startsWith("007")).toBe(true);
    expect(token.length).toBeGreaterThan(100);
  });

  it("produces a different token per channel/uid combination", () => {
    const a = generateAgoraToken("channel-a", "user-1");
    const b = generateAgoraToken("channel-b", "user-1");
    expect(a).not.toBe(b);
  });
});
