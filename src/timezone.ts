const OFFSET_FLOOR = -720;
const OFFSET_CEIL = 840;
const MS_PER_MINUTE = 60_000;

const OFFSET_PATTERN = /^(?:UTC|GMT)(?:([+-])(\d{1,2})(?::?([0-5]\d))?)?$/;

function compactUpper(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

function offsetFromPatternMatch(match: RegExpMatchArray): number | null {
  const signToken = match[1];
  if (signToken == null) return 0;
  const hourPart = Number(match[2]);
  const minutePart = match[3] != null ? Number(match[3]) : 0;
  if (!Number.isFinite(hourPart) || !Number.isFinite(minutePart)) return null;
  if (hourPart > 14) return null;
  const magnitude = hourPart * 60 + minutePart;
  const signed = signToken === "-" ? -magnitude : magnitude;
  if (signed < OFFSET_FLOOR || signed > OFFSET_CEIL) return null;
  return signed;
}

function ianaZoneCurrentOffset(zoneName: string): number | null {
  try {
    const pieces = new Intl.DateTimeFormat("en-US", {
      timeZone: zoneName,
      timeZoneName: "shortOffset",
      hour: "2-digit",
    }).formatToParts(new Date());
    const tzPart = pieces.find((piece) => piece.type === "timeZoneName");
    if (!tzPart) return null;
    const found = compactUpper(tzPart.value).match(OFFSET_PATTERN);
    if (!found) return null;
    const resolved = offsetFromPatternMatch(found);
    return resolved == null ? null : clampTimezoneOffsetMinutes(resolved);
  } catch {
    return null;
  }
}

function isIanaRecognised(zoneName: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zoneName }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function clampTimezoneOffsetMinutes(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const whole = Math.round(value);
  if (whole < OFFSET_FLOOR) return OFFSET_FLOOR;
  if (whole > OFFSET_CEIL) return OFFSET_CEIL;
  return whole;
}

export function parseUtcOffsetMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const squashed = compactUpper(value);
  if (squashed.length === 0) return null;
  const hit = squashed.match(OFFSET_PATTERN);
  return hit ? offsetFromPatternMatch(hit) : null;
}

export function normalizeTimezoneName(value: unknown): string {
  if (typeof value !== "string") return "";
  const stripped = value.trim();
  if (stripped.length === 0) return "";

  if (parseUtcOffsetMinutes(stripped) != null) {
    return compactUpper(stripped);
  }

  return isIanaRecognised(stripped) ? stripped : "";
}

export function resolveTimezoneOffsetMinutes(value: unknown, timezoneFallback?: string): number {
  let numeric: number = Number.NaN;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string") {
    numeric = Number(value.trim());
  }
  if (Number.isFinite(numeric)) {
    return clampTimezoneOffsetMinutes(numeric);
  }

  if (typeof timezoneFallback === "string" && timezoneFallback.trim().length > 0) {
    const direct = parseUtcOffsetMinutes(timezoneFallback);
    if (direct != null) return direct;
    const viaIana = ianaZoneCurrentOffset(timezoneFallback.trim());
    if (viaIana != null) return viaIana;
  }

  return 0;
}

export function shiftDateToOffset(date: Date, timezoneOffsetMinutes: number): Date {
  const safeOffset = clampTimezoneOffsetMinutes(timezoneOffsetMinutes);
  return new Date(date.getTime() + safeOffset * MS_PER_MINUTE);
}

export function formatUtcOffsetLabel(timezoneOffsetMinutes: number): string {
  const bounded = clampTimezoneOffsetMinutes(timezoneOffsetMinutes);
  const polarity = bounded < 0 ? "-" : "+";
  const distance = Math.abs(bounded);
  const hourChunk = Math.floor(distance / 60);
  const minuteChunk = distance - hourChunk * 60;
  if (minuteChunk === 0) {
    return `UTC${polarity}${hourChunk}`;
  }
  const minuteText = minuteChunk < 10 ? `0${minuteChunk}` : String(minuteChunk);
  return `UTC${polarity}${hourChunk}:${minuteText}`;
}

function twoDigit(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function buildClockPromptPrefix(date: Date, timezoneOffsetMinutes: number): string {
  const moved = shiftDateToOffset(date, timezoneOffsetMinutes);
  const y = moved.getUTCFullYear();
  const mo = twoDigit(moved.getUTCMonth() + 1);
  const d = twoDigit(moved.getUTCDate());
  const h = twoDigit(moved.getUTCHours());
  const mi = twoDigit(moved.getUTCMinutes());
  const s = twoDigit(moved.getUTCSeconds());
  const label = formatUtcOffsetLabel(timezoneOffsetMinutes);
  return `[${y}-${mo}-${d} ${h}:${mi}:${s} ${label}]`;
}

export function getDayAndMinuteAtOffset(
  date: Date,
  timezoneOffsetMinutes: number,
): { day: number; minute: number } {
  const moved = shiftDateToOffset(date, timezoneOffsetMinutes);
  return {
    day: moved.getUTCDay(),
    minute: moved.getUTCHours() * 60 + moved.getUTCMinutes(),
  };
}
