import { describe, expect, test } from "bun:test";
import { checkAuth, type AuthPolicy } from "./auth";
import type { Envelope } from "./envelope";

function makeEnvelope(userId: string, isAdmin = false): Envelope {
  return {
    source: "discord",
    workspace: "/tmp/proj",
    user: { id: userId, isAdmin },
    message: { text: "hi" },
    attachments: [],
    trigger: "mention",
    receivedAt: new Date("2026-04-16T00:00:00Z"),
  };
}

describe("checkAuth", () => {
  test("empty allowlist → DENY (fail-closed) with reason no-allowlist-configured", () => {
    // An empty allowlist on a bridge exposed to the internet is fail-open;
    // the daemon now refuses traffic in that state so a misconfigured
    // settings.json cannot accidentally turn the bot into an open relay.
    const policy: AuthPolicy = { allowedUserIds: [] };
    const decision = checkAuth(makeEnvelope("U1"), policy);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("no-allowlist-configured");
    expect(decision.isAdmin).toBe(false);
  });

  test("user in allowlist → allow with reason user-in-allowlist", () => {
    const policy: AuthPolicy = { allowedUserIds: ["U1", "U2"] };
    const decision = checkAuth(makeEnvelope("U1"), policy);
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("user-in-allowlist");
    expect(decision.isAdmin).toBe(false);
  });

  test("user not in allowlist → deny with reason user-not-in-allowlist", () => {
    const policy: AuthPolicy = { allowedUserIds: ["U1", "U2"] };
    const decision = checkAuth(makeEnvelope("U3"), policy);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("user-not-in-allowlist");
    expect(decision.isAdmin).toBe(false);
  });

  test("admin always wins even when not in allowlist", () => {
    const policy: AuthPolicy = {
      allowedUserIds: ["someone-else"],
      allowedAdmins: ["U1"],
    };
    const decision = checkAuth(makeEnvelope("U1"), policy);
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("admin");
    expect(decision.isAdmin).toBe(true);
  });

  test("admin wins over empty allowlist too", () => {
    const policy: AuthPolicy = {
      allowedUserIds: [],
      allowedAdmins: ["U1"],
    };
    const decision = checkAuth(makeEnvelope("U1"), policy);
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("admin");
    expect(decision.isAdmin).toBe(true);
  });

  test("admin wins when also in allowlist (admin reason takes precedence)", () => {
    const policy: AuthPolicy = {
      allowedUserIds: ["U1"],
      allowedAdmins: ["U1"],
    };
    const decision = checkAuth(makeEnvelope("U1"), policy);
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("admin");
    expect(decision.isAdmin).toBe(true);
  });

  test("non-admin is marked isAdmin=false even when allowed", () => {
    const policy: AuthPolicy = {
      allowedUserIds: ["U1"],
      allowedAdmins: ["other"],
    };
    const decision = checkAuth(makeEnvelope("U1"), policy);
    expect(decision.isAdmin).toBe(false);
  });

  test("allowedAdmins undefined is treated as no admins", () => {
    const policy: AuthPolicy = { allowedUserIds: ["U1"] };
    const decision = checkAuth(makeEnvelope("U1"), policy);
    expect(decision.isAdmin).toBe(false);
    expect(decision.reason).toBe("user-in-allowlist");
  });

  test("envelope.user.isAdmin flag is NOT consulted — policy.allowedAdmins is authoritative", () => {
    // envelope says admin, policy does not list them → not an admin.
    const policy: AuthPolicy = { allowedUserIds: ["U1"] };
    const decision = checkAuth(makeEnvelope("U1", true), policy);
    expect(decision.isAdmin).toBe(false);
    expect(decision.reason).toBe("user-in-allowlist");
  });
});
