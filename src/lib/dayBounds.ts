// Calendar-day boundaries in a named IANA time zone (e.g. "Asia/Kolkata"),
// using only the built-in Intl API. Hosts are India-first, so every "today"
// / "per day" figure shown to a host must use their local midnight, not UTC
// midnight (which is 05:30 IST).

export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// True only for a real calendar date in YYYY-MM-DD form ("2026-02-30" is false).
export function isValidDateString(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d;
}

// The YYYY-MM-DD calendar date `at` falls on in `tz`.
export function dateInTimeZone(at: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

// How far ahead of UTC `tz` is at instant `at`, in ms (IST → +19_800_000).
function timeZoneOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const wallClockAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallClockAsUtc - Math.floor(at.getTime() / 1000) * 1000;
}

// The instant local midnight starts `date` in `tz`. Offset is computed twice
// so a DST change near midnight (not an issue for IST, but tz is a
// parameter) still lands on the right instant.
export function startOfDayInTimeZone(date: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d);
  const firstGuess = naive - timeZoneOffsetMs(new Date(naive), tz);
  return new Date(naive - timeZoneOffsetMs(new Date(firstGuess), tz));
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// [start, end) of the local calendar day `date` in `tz`.
export function dayRangeInTimeZone(date: string, tz: string): { start: Date; end: Date } {
  return { start: startOfDayInTimeZone(date, tz), end: startOfDayInTimeZone(addDays(date, 1), tz) };
}
