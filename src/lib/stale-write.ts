/**
 * Two people editing the same record (#655, F-25). Each save sends the
 * `updated_at` its screen loaded with, and the server refuses it when the row
 * has changed since, instead of writing over the other person's change.
 *
 * This file is shared by the server (the refusal) and the browser (telling a
 * refusal apart from any other error, so it can offer Reload). The check
 * itself is in stale-write.server.ts.
 */

export type StaleRecordKind = "client" | "visit" | "invoice";

const PREFIX = "Someone else changed this ";

/** The words a person reads when their save is refused. */
export function staleWriteMessage(kind: StaleRecordKind): string {
  return `${PREFIX}${kind} after you opened it, so your change was not saved. Reload to see the latest, then make your change again.`;
}

export function isStaleWriteError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return message.startsWith(PREFIX) && message.includes("after you opened it");
}

/**
 * Microseconds since the epoch, from a Postgres timestamptz as PostgREST
 * prints it ("2026-11-02T10:00:00.123456+00:00") or as JavaScript does
 * ("2026-11-02T10:00:00.123Z"). Date.parse alone keeps milliseconds only,
 * and a trigger's now() has six digits, so two writes in the same millisecond
 * would read as the same moment.
 */
function micros(ts: string): number | null {
  const m = /^(.*?T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(ts.trim().replace(" ", "T"));
  if (!m) return null;
  // Postgres's own text form can end "+00" or "+05:30"; ISO wants "+00:00".
  const zone = (m[3] || "Z").replace(/^([+-]\d{2})$/, "$1:00");
  const whole = Date.parse(`${m[1]}${zone}`);
  if (Number.isNaN(whole)) return null;
  const frac = Number((m[2] ?? "").padEnd(6, "0").slice(0, 6));
  return whole * 1000 + frac;
}

/** Whether two timestamps name the same instant, to the microsecond. */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  const x = micros(a);
  const y = micros(b);
  return x != null && y != null && x === y;
}
