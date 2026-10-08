// Wall-clock ↔ UTC conversion for IANA timezones (packet M2.1 §12.4).
// Pure. Instants are stored in UTC; staff enter and read local times in
// the cycle's display timezone. Nonexistent (spring-forward) and
// ambiguous (fall-back) local times are rejected rather than guessed.

const localPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

type Parts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}>;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallClock(utcMs: number, timeZone: string): Parts {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(new Date(utcMs))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
  };
}

function asUtc(p: Parts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/** Offset (ms) of the zone at an instant: wall clock minus UTC. */
function offsetAt(utcMs: number, timeZone: string): number {
  const floored = utcMs - (utcMs % 60_000);
  return asUtc(wallClock(floored, timeZone)) - floored;
}

export type ZonedParse =
  | Readonly<{ ok: true; instant: Date }>
  | Readonly<{
      ok: false;
      problem: "INVALID" | "NONEXISTENT_LOCAL_TIME" | "AMBIGUOUS_LOCAL_TIME";
    }>;

/** Parses "YYYY-MM-DDTHH:mm" as a wall-clock time in the timezone. */
export function parseZonedLocal(input: unknown, timeZone: string): ZonedParse {
  if (typeof input !== "string") return { ok: false, problem: "INVALID" };
  const match = localPattern.exec(input.trim());
  if (!match) return { ok: false, problem: "INVALID" };
  const target: Parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const guess = asUtc(target);
  const check = new Date(guess);
  if (
    target.year < 2000 ||
    target.year > 2100 ||
    check.getUTCMonth() + 1 !== target.month ||
    check.getUTCDate() !== target.day ||
    target.hour > 23 ||
    target.minute > 59
  ) {
    return { ok: false, problem: "INVALID" };
  }
  const day = 86_400_000;
  const offsets = new Set(
    [guess - day, guess, guess + day].map((t) => offsetAt(t, timeZone)),
  );
  const matches = new Set<number>();
  for (const offset of offsets) {
    const candidate = guess - offset;
    if (asUtc(wallClock(candidate, timeZone)) === guess) matches.add(candidate);
  }
  if (matches.size === 0)
    return { ok: false, problem: "NONEXISTENT_LOCAL_TIME" };
  if (matches.size > 1) return { ok: false, problem: "AMBIGUOUS_LOCAL_TIME" };
  return { ok: true, instant: new Date([...matches][0]!) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DDTHH:mm" in the timezone (for datetime-local inputs). */
export function toZonedLocal(instant: Date, timeZone: string): string {
  const p = wallClock(instant.getTime(), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

const displayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Human-readable date and time with the zone name, e.g. "Oct 9, 2026, 5:00 PM EDT". */
export function formatInZone(instant: Date, timeZone: string): string {
  let formatter = displayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    });
    displayFormatters.set(timeZone, formatter);
  }
  const zoneName =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(instant)
      .find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  return `${formatter.format(instant)} ${zoneName}`;
}
