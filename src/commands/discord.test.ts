import { afterEach, describe, expect, test } from "bun:test";

import { sendReaction } from "./discord";

// PL-2: sendReaction should route through discordApi() so that a Discord 429
// rate-limit is retried (honoring `retry_after`) instead of silently dropping
// the reaction. Today the function calls raw fetch(...).catch(() => {}), so a
// 429 is swallowed on the first hit and `fetch` is invoked exactly once. Once
// the body is swapped to `await discordApi(...)`, the helper will re-fetch and
// the call count becomes 2.

describe("discord sendReaction — PL-2", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("retries on 429 rate-limit via discordApi", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      if (calls.length === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ retry_after: 0.01 }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof globalThis.fetch;

    await sendReaction("fake-token", "fake-channel", "fake-message", "\u{1F44D}");

    // Two fetches: first 429, then the retry issued by discordApi().
    expect(calls.length).toBe(2);

    const finalUrl = calls[calls.length - 1]?.url ?? "";
    expect(finalUrl).toContain("/channels/fake-channel/messages/fake-message/reactions/");
    expect(finalUrl.endsWith("/@me")).toBe(true);
    // Thumbs-up (U+1F44D) URL-encodes to %F0%9F%91%8D.
    expect(finalUrl).toContain("/reactions/%F0%9F%91%8D/");
  });
});
