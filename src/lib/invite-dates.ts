/**
 * What a pending invite row says about time: when it was sent and when the
 * link stops working. Both come from columns the list already reads
 * (org_invites.created_at, expires_at), so this is display only (#1043).
 */
const day = (iso: string, withYear: boolean) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });

export function inviteTimingLine(
  createdAt: string | null | undefined,
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const ok = (v: string | null | undefined): v is string => !!v && !Number.isNaN(Date.parse(v));
  const parts: string[] = [];
  const year = (v: string) => new Date(v).getFullYear() !== now.getFullYear();
  if (ok(createdAt)) parts.push(`Sent ${day(createdAt, year(createdAt))}`);
  if (ok(expiresAt)) {
    parts.push(
      Date.parse(expiresAt) <= now.getTime()
        ? `expired ${day(expiresAt, year(expiresAt))}`
        : `expires ${day(expiresAt, year(expiresAt))}`,
    );
  }
  return parts.length ? parts.join(" · ") : null;
}
