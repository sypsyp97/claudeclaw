export interface ThreadIntent {
  action: "hire" | "fire";
  names: string[];
}

// Multi-character keywords checked first (longest-prefix-wins style).
// Order within each list doesn't matter because we scan the string and
// keep the leftmost match, but listing longer tokens first makes intent obvious.
const HIRE_MULTI: readonly string[] = [
  "hire",
  "spawn",
  "deploy",
  "派出",
  "出征",
  "上陣",
  "迎戰",
  "出戰",
  "建立",
];
const FIRE_MULTI: readonly string[] = [
  "fire",
  "remove",
  "delete",
  "kill",
  "撤回",
  "收回",
  "叫回來",
  "關閉",
];
// Single-character CJK verbs — these only count as a match when followed by
// whitespace/punctuation/end-of-string to avoid matching inside compounds
// like 開啟, 開始, 開心, 派對, 撤銷, 關機, 刪除 (刪 is OK here since 刪除 is
// itself a fire verb — but we still want 刪 alone to match only at a boundary).
const HIRE_SINGLE: readonly string[] = ["開", "派"];
const FIRE_SINGLE: readonly string[] = ["撤", "刪", "關", "滾"];

// Boundary = end-of-string, ASCII whitespace, or common ASCII/CJK punctuation.
// We deliberately treat CJK characters as NOT a boundary, so 派對/開始 etc.
// are rejected but "派 劉備" / "派, 劉備" pass.
const BOUNDARY = /[\s,.;:!?，。、！？,&]/;

function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  return BOUNDARY.test(ch);
}

interface Match {
  index: number;
  end: number;
  action: "hire" | "fire";
}

function findMultiMatch(text: string, keywords: readonly string[], action: "hire" | "fire"): Match | null {
  const lower = text.toLowerCase();
  let best: Match | null = null;
  for (const kw of keywords) {
    const needle = kw.toLowerCase();
    const idx = lower.indexOf(needle);
    if (idx === -1) continue;
    if (!best || idx < best.index) {
      best = { index: idx, end: idx + kw.length, action };
    }
  }
  return best;
}

function findSingleMatch(text: string, keywords: readonly string[], action: "hire" | "fire"): Match | null {
  let best: Match | null = null;
  for (const kw of keywords) {
    let from = 0;
    while (from < text.length) {
      const idx = text.indexOf(kw, from);
      if (idx === -1) break;
      const after = text[idx + kw.length];
      if (isBoundary(after)) {
        if (!best || idx < best.index) {
          best = { index: idx, end: idx + kw.length, action };
        }
        break;
      }
      from = idx + kw.length;
    }
  }
  return best;
}

// Split the tail string into name tokens.
// Separators: ASCII whitespace, "," "，" "、" "&" "和" "跟" "與",
// and the literal " with " (case-insensitive, whitespace on both sides).
function extractNames(tail: string): string[] {
  // Normalize " with " / " and " (whitespace-bounded, case-insensitive) to a separator.
  let normalized = tail.replace(/(^|\s)(with|and)(\s|$)/gi, "$1,$3");
  // Replace every configured separator with a single comma so we can do one split.
  normalized = normalized.replace(/[\s，、&和跟與]/g, ",");
  const parts = normalized.split(",");
  const trimPattern = /^[\s.。!！?？,，、;；:：]+|[\s.。!！?？,，、;；:：]+$/g;
  const names: string[] = [];
  for (const raw of parts) {
    const cleaned = raw.replace(trimPattern, "");
    if (cleaned.length > 0) names.push(cleaned);
    if (names.length >= 10) break;
  }
  return names;
}

/**
 * Pure pattern-based thread-management intent classifier.
 * Never spawns a subprocess, never touches the filesystem, never
 * makes network calls. Safe to call on the gateway hot path.
 */
export function classifyThreadIntent(text: string): ThreadIntent | null {
  if (!text) return null;

  // Prefer multi-character matches; only fall back to single-character
  // verbs when no multi-char keyword was found.
  let hire = findMultiMatch(text, HIRE_MULTI, "hire");
  let fire = findMultiMatch(text, FIRE_MULTI, "fire");
  if (!hire) hire = findSingleMatch(text, HIRE_SINGLE, "hire");
  if (!fire) fire = findSingleMatch(text, FIRE_SINGLE, "fire");

  let chosen: Match | null;
  if (hire && fire) {
    chosen = hire.index <= fire.index ? hire : fire;
  } else {
    chosen = hire ?? fire;
  }
  if (!chosen) return null;

  const tail = text.slice(chosen.end);
  const names = extractNames(tail);
  if (names.length === 0) return null;

  return { action: chosen.action, names };
}
