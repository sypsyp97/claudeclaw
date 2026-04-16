/**
 * Channel policy — the declarative replacement for the old `listenChannels`
 * list plus the hire/fire LLM classifier.
 *
 * Every source+guild+channel triple resolves to one of these; the router
 * reads the policy to decide session scope, memory layer, allowed skills,
 * and model. Defaults live here so a totally un-configured daemon still
 * behaves sensibly.
 */

import type { Source } from "../router/envelope";

export type ChannelMode = "listen" | "mention" | "free-response" | "delivery-only" | "shared";

export type ChannelSessionScope = "per-user" | "per-channel-user" | "per-thread" | "shared";

export type MemoryScope = "user" | "channel" | "workspace" | "none";

export interface ChannelPolicy {
  mode: ChannelMode;
  sessionScope: ChannelSessionScope;
  autoThread: boolean;
  memoryScope: MemoryScope;
  allowedSkills: string[] | "*";
  modelPolicy?: { model?: string; fallback?: string };
  deliveryRole: "interactive" | "delivery";
}

export interface PolicyLookup {
  source: Source;
  guild?: string;
  channel?: string;
  isDm?: boolean;
}

const DM_DEFAULT: ChannelPolicy = {
  mode: "mention",
  sessionScope: "per-user",
  autoThread: false,
  memoryScope: "user",
  allowedSkills: "*",
  deliveryRole: "interactive",
};

const SERVER_DEFAULT: ChannelPolicy = {
  mode: "mention",
  sessionScope: "per-channel-user",
  autoThread: false,
  memoryScope: "channel",
  allowedSkills: "*",
  deliveryRole: "interactive",
};

const LISTEN_DEFAULT: ChannelPolicy = {
  mode: "free-response",
  sessionScope: "per-channel-user",
  autoThread: false,
  memoryScope: "channel",
  allowedSkills: "*",
  deliveryRole: "interactive",
};

const DELIVERY_DEFAULT: ChannelPolicy = {
  mode: "delivery-only",
  sessionScope: "shared",
  autoThread: false,
  memoryScope: "none",
  allowedSkills: [],
  deliveryRole: "delivery",
};

// Shallow-spread leaks the module-level array references; clone every
// nested-mutable field so callers can safely .push() into the result.
function clonePolicy(p: ChannelPolicy): ChannelPolicy {
  return {
    ...p,
    allowedSkills: p.allowedSkills === "*" ? "*" : [...p.allowedSkills],
    modelPolicy: p.modelPolicy ? { ...p.modelPolicy } : undefined,
  };
}

export function defaultPolicy(lookup: PolicyLookup): ChannelPolicy {
  if (lookup.isDm) return clonePolicy(DM_DEFAULT);
  return clonePolicy(SERVER_DEFAULT);
}

export function listenPolicy(): ChannelPolicy {
  return clonePolicy(LISTEN_DEFAULT);
}

export function deliveryPolicy(): ChannelPolicy {
  return clonePolicy(DELIVERY_DEFAULT);
}

export function mergePolicy(base: ChannelPolicy, override: Partial<ChannelPolicy>): ChannelPolicy {
  const merged: ChannelPolicy = { ...base, ...override };
  // Make sure overrides also produce an independent copy of any array/object.
  if (override.allowedSkills !== undefined) {
    merged.allowedSkills = override.allowedSkills === "*" ? "*" : [...override.allowedSkills];
  } else if (base.allowedSkills !== "*") {
    merged.allowedSkills = [...base.allowedSkills];
  }
  if (override.modelPolicy) {
    merged.modelPolicy = { ...override.modelPolicy };
  } else if (base.modelPolicy) {
    merged.modelPolicy = { ...base.modelPolicy };
  }
  return merged;
}
