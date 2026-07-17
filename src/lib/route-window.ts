// Route window/ETA anchoring (QA round 3, finding B6 part 2). The route
// optimizer must anchor each day's first arrival at the org's LOCAL workday
// start, in the org's timezone — never at UTC midnight/08:00, which renders as
// 3-4 AM in US timezones (the "route ends 04:24 AM / ETA 04:00 AM" bug).
// optimize_route_v2 implements this in SQL via
// `(day + workday_start) AT TIME ZONE org.timezone`; this module is the same
// contract expressed in TypeScript, plus the shared frontend defaults.

export const DEFAULT_TIMEZONE = "America/Chicago";
export const DEFAULT_WORKDAY_START = "08:00";
export const DEFAULT_WORKDAY_END = "17:00";

/** Common US IANA zones offered in dispatch settings. */
export const US_TIMEZONES: Array<{ value: string; label: string }> = [
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Phoenix", label: "Mountain, no DST (Phoenix)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "America/Anchorage", label: "Alaska (Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii (Honolulu)" },
];

/** The UTC instant for a wall-clock (date + HH:MM) in an IANA timezone.
 *  zonedTimeToUtc("2026-07-22", "08:00", "America/Chicago") is 13:00 UTC (CDT),
 *  NOT 08:00 UTC. This is exactly what the SQL `AT TIME ZONE` produces. */
export function zonedTimeToUtc(dateISO: string, timeHHMM: string, timeZone: string): Date {
  const [y, mo, d] = dateISO.split("-").map(Number);
  const [hh, mm] = timeHHMM.split(":").map(Number);
  const asUtcMs = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(asUtcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  let zh = get("hour");
  if (zh === 24) zh = 0; // some engines emit "24" for midnight
  const zonedAsUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), zh, get("minute"), get("second"));
  const offsetMs = zonedAsUtcMs - asUtcMs;
  return new Date(asUtcMs - offsetMs);
}

/** The instant at which the workday starts on a given day, in the org tz. */
export function workdayStartInstant(
  dateISO: string,
  workdayStart: string = DEFAULT_WORKDAY_START,
  timeZone: string = DEFAULT_TIMEZONE,
): Date {
  return zonedTimeToUtc(dateISO, workdayStart.slice(0, 5), timeZone);
}
