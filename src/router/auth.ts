/**
 * Auth check — does the user in this envelope have permission to be handled?
 *
 * Read from the existing settings.allowedUserIds / security config. Returns
 * a structured decision so callers can log the reason even on deny.
 */

import type { Envelope } from "./envelope";

export interface AuthPolicy {
  allowedUserIds: string[];
  allowedAdmins?: string[];
}

export interface AuthDecision {
  allow: boolean;
  reason: string;
  isAdmin: boolean;
}

export function checkAuth(envelope: Envelope, policy: AuthPolicy): AuthDecision {
  const userId = envelope.user.id;
  const admin = policy.allowedAdmins?.includes(userId) ?? false;
  if (admin) return { allow: true, reason: "admin", isAdmin: true };

  if (policy.allowedUserIds.length === 0) {
    // Fail-closed: an empty allowlist means "not configured yet", not "open
    // relay". A messaging bridge exposed to the internet cannot default to
    // accepting anyone.
    return { allow: false, reason: "no-allowlist-configured", isAdmin: false };
  }
  if (policy.allowedUserIds.includes(userId)) {
    return { allow: true, reason: "user-in-allowlist", isAdmin: false };
  }
  return { allow: false, reason: "user-not-in-allowlist", isAdmin: false };
}
