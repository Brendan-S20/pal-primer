/**
 * Whether an organization is a demo account, which is the only kind the
 * Reseed button may wipe. One definition for the server's refusal
 * (demo.functions.ts) and for whether Settings shows the card at all, so a
 * real business is never offered a destructive button its server will refuse.
 */
export function isDemoOrganization(
  org: { slug?: string | null; is_comped?: boolean | null } | null | undefined,
): boolean {
  return !!org && (org.is_comped === true || org.slug === "demo");
}
