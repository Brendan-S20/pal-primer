// Display formatting helpers (QA follow-up 3.3): store canonical values,
// render humanized ones. Dates read "Mon, Jul 20", phones "(734) 309-3494".

/** "(734) 309-3494" for 10-digit US numbers; original string otherwise. */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return raw;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

/** "Mon, Jul 20" (adds the year when it isn't the current one). */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "";
  // Date-only strings are parsed as UTC by Date; anchor to noon local so the
  // rendered weekday can't slip a day in western timezones.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** A payment's parts, when a card surcharge was passed through.
 *
 *  `payments.amount_cents` is the invoice amount; `surcharge_cents` sits
 *  beside it so the surcharge is never counted as revenue. Their sum is the
 *  only number the customer ever sees — it is what hit the card — so any
 *  screen showing a payment has to show the sum, and say where it came from
 *  or it looks like the invoice was wrong.
 *
 *  Returns null when there is no surcharge, which is the common case and
 *  means "just render the amount". */
export function surchargeSplit(
  amountCents: number | null | undefined,
  surchargeCents: number | null | undefined,
): { chargedCents: number; baseCents: number; feeCents: number } | null {
  const base = amountCents ?? 0;
  const fee = surchargeCents ?? 0;
  if (fee <= 0) return null;
  return { chargedCents: base + fee, baseCents: base, feeCents: fee };
}

/** "Jul 20, 3:42 PM" for timestamps.
 *
 * `tz` renders the instant on the ORGANIZATION's clock instead of the
 * device's — pass it (from `useOrgTimezone()`) for anything about a visit or
 * the schedule. Omitted, the device clock applies, which remains right for
 * timestamps about the reader's own actions (a note they just wrote, an
 * activity entry they just caused). */
export function formatDateTime(iso: string | null | undefined, tz?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString([], {
    ...(tz ? { timeZone: tz } : {}),
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "3:42 PM". Same `tz` contract as `formatDateTime` above. */
export function formatTime(iso: string | null | undefined, tz?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], {
    ...(tz ? { timeZone: tz } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Arrival window: "8:00 AM – 12:00 PM", "After 8:00 AM", "By 12:00 PM",
 * or "Anytime" when no bound is set. */
export function formatWindow(
  earliest: string | null | undefined,
  latest: string | null | undefined,
): string {
  if (earliest && latest) return `${formatClock(earliest)} – ${formatClock(latest)}`;
  if (earliest) return `After ${formatClock(earliest)}`;
  if (latest) return `By ${formatClock(latest)}`;
  return "Anytime";
}

/** "8:00 AM" from a Postgres time-of-day string like "08:00:00". */
export function formatClock(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Jul 20, 2026": a calendar day on a document that will be filed.
 *
 *  `formatDay` drops the year when it is the current one, which is right on
 *  a screen read today and wrong on a PDF a bookkeeper opens next spring.
 *  Takes a YYYY-MM-DD day that is ALREADY on the org's calendar (use
 *  `orgLocalDay` for an instant first) and formats it in UTC, where a bare
 *  date lives, so no server or device timezone can move it a day. */
export function formatDocumentDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return day ?? "";
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
