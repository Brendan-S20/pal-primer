/**
 * Two people with the same client, visit or invoice open (F-25, #655).
 *
 * A form sends the `updated_at` it was loaded with. The server compares it
 * with the row as it is now and refuses the write if they differ, so the
 * second save cannot quietly replace the first. The office is then told to
 * reload, see what changed, and make their change again.
 *
 * For an invoice that includes payments: a payment row fires
 * payments_sync_invoice_paid, which rewrites invoices.amount_paid_cents, and
 * touch_invoices moves updated_at with it.
 *
 * Shared by the server functions and the screens, so it imports nothing.
 */

/** What the server says when the row changed. The screens match on it. */
export const STALE_WRITE_MESSAGE =
  "Someone else saved a change to this while you had it open. Reload to see it, then make your change again.";

/** Short title for the toast. */
export const STALE_WRITE_TITLE = "This was changed by someone else";

export class StaleWriteError extends Error {
  constructor() {
    super(STALE_WRITE_MESSAGE);
    this.name = "StaleWriteError";
  }
}

export function isStaleWriteError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return msg.includes(STALE_WRITE_MESSAGE);
}

/**
 * A Postgres timestamp as microseconds since the epoch. PostgREST returns
 * six fractional digits ("2026-11-02T10:00:00.123456+00:00") and `Date.parse`
 * keeps only three, so two writes in the same millisecond would compare equal.
 * Returns null for anything that does not parse.
 */
export function instantMicros(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const m = /^(.*?[T ]\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(ts.trim());
  if (!m) {
    const ms = Date.parse(ts);
    return Number.isNaN(ms) ? null : ms * 1000;
  }
  const zone = m[3] && m[3].length > 0 ? m[3] : "Z";
  const ms = Date.parse(`${m[1].replace(" ", "T")}${zone}`);
  if (Number.isNaN(ms)) return null;
  const micros = Number((m[2] ?? "").padEnd(6, "0").slice(0, 6));
  return ms * 1000 + micros;
}

/** Same moment, whatever the spelling ("Z" or "+00:00", 3 or 6 digits). */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = instantMicros(a);
  const y = instantMicros(b);
  if (x == null || y == null) return x == null && y == null;
  return x === y;
}

/**
 * Throws StaleWriteError when the caller sent a version and it is not the
 * current one. A caller that sent nothing (an older build, or a control that
 * is not a form, like the board's drag) is not checked.
 */
export function refuseIfChanged(
  current: string | null | undefined,
  expected: string | null | undefined,
): void {
  if (expected === undefined) return;
  if (!sameInstant(current, expected)) throw new StaleWriteError();
}
