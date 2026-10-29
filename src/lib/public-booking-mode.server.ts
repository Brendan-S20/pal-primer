// Reading the owner's public booking mode (#574) with the service role, for
// the business the public lookup resolved. See public-booking-mode.ts for the
// rules; this is only the reads.
import {
  storedPublicBookingMode,
  type PublicBookingMode,
  type PublicPackage,
} from "@/lib/public-booking-mode";

export type PublicBooking = { mode: PublicBookingMode; pack: PublicPackage | null };

/** Postgres's "no such column": a database the mode migration has not
 *  reached. The link is then what it was, a repeating plan. */
function isMissingColumn(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42703" || error?.code === "PGRST204";
}

/**
 * Each listed service's mode and, for a package, the package it sells. A
 * package counts only when it is this business's, for this service, and
 * still on sale. A mobile groom is a day and a time on a van, never a
 * package, so a groom set to package is asked for instead.
 *
 * Null when the database has no mode column yet, so the caller leaves the
 * services as they were.
 */
export async function loadPublicBookings(
  admin: any,
  orgId: string,
  services: ReadonlyArray<{ id: string; service_line: string }>,
): Promise<Map<string, PublicBooking> | null> {
  const out = new Map<string, PublicBooking>();
  if (services.length === 0) return out;
  const { data: rows, error } = await admin
    .from("services")
    .select("id, public_booking_mode, public_package_id")
    .eq("organization_id", orgId)
    .in(
      "id",
      services.map((s) => s.id),
    );
  if (isMissingColumn(error)) return null;
  if (error) throw new Error(error.message);
  const typed = (rows ?? []) as Array<{
    id: string;
    public_booking_mode: unknown;
    public_package_id: string | null;
  }>;
  const packIds = [
    ...new Set(typed.map((r) => r.public_package_id).filter((v): v is string => !!v)),
  ];
  const packs = new Map<string, PublicPackage & { service_id: string; active: boolean }>();
  if (packIds.length > 0) {
    const { data: packRows, error: pErr } = await admin
      .from("service_packages")
      .select("id, service_id, name, sessions_count, price_cents, active")
      .eq("organization_id", orgId)
      .in("id", packIds);
    if (pErr) throw new Error(pErr.message);
    for (const p of (packRows ?? []) as Array<
      PublicPackage & { service_id: string; active: boolean }
    >)
      packs.set(p.id, p);
  }
  const lineOf = new Map(services.map((s) => [s.id, s.service_line]));
  for (const r of typed) {
    const p = r.public_package_id ? packs.get(r.public_package_id) : undefined;
    out.set(r.id, bookingFromRow(r, p, lineOf.get(r.id)));
  }
  return out;
}

/** One row's booking. A row with no mode key at all came from a database the
 *  column has not reached: the link as it was. A NULL mode is request only. */
function bookingFromRow(
  r: { id: string; public_booking_mode?: unknown },
  p: (PublicPackage & { service_id: string; active: boolean }) | null | undefined,
  line: string | undefined,
): PublicBooking {
  if (!("public_booking_mode" in r)) return { mode: "recurring", pack: null };
  const pack: PublicPackage | null =
    p && p.active && p.service_id === r.id
      ? { id: p.id, name: p.name, sessions_count: p.sessions_count, price_cents: p.price_cents }
      : null;
  let mode = storedPublicBookingMode(r.public_booking_mode, pack);
  if (mode === "package" && line === "mobile_grooming") mode = "request_only";
  return { mode, pack: mode === "package" ? pack : null };
}

/** The mode of the one service a quote or a checkout names. No service named
 *  is the business's default service, the pet-waste plan the link always
 *  sold. */
export async function loadPublicBooking(
  admin: any,
  orgId: string,
  service: { id: string; service_line: string } | null,
): Promise<PublicBooking> {
  if (!service) return { mode: "recurring", pack: null };
  const { data: row, error } = await admin
    .from("services")
    .select("id, public_booking_mode, public_package_id")
    .eq("id", service.id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (isMissingColumn(error)) return { mode: "recurring", pack: null };
  if (error) throw new Error(error.message);
  if (!row) return { mode: "request_only", pack: null };
  let pack: (PublicPackage & { service_id: string; active: boolean }) | null = null;
  if (row.public_package_id) {
    const { data: p, error: pErr } = await admin
      .from("service_packages")
      .select("id, service_id, name, sessions_count, price_cents, active")
      .eq("id", row.public_package_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (pErr) throw new Error(pErr.message);
    pack = p ?? null;
  }
  return bookingFromRow(row, pack, service.service_line);
}
