export const REQUIRED_VACCINES = [
  "rabies",
  "dhpp",
  "bordetella",
  "leptospirosis",
  "canine_influenza",
] as const;
export const VACCINES = [...REQUIRED_VACCINES, "other"] as const;
export type Vaccine = (typeof VACCINES)[number];
export type VaccineRule = "off" | "warn" | "block";
export type VaccineState = "ok" | "expiring" | "expired" | "missing";
export type VaccineRecord = {
  vaccine: string;
  expires_on: string;
  source: string;
  verified_at: string | null;
};
export type VaccineStatus = {
  vaccines: {
    vaccine: string;
    state: VaccineState;
    expiresOn: string | null;
    unverified: boolean;
  }[];
  overall: VaccineState;
};
const severity: Record<VaccineState, number> = { ok: 0, expiring: 1, expired: 2, missing: 3 };

/** Calendar dates use UTC arithmetic so daylight saving does not shift the 30-day boundary. */
export function vaccineStatus(
  records: readonly VaccineRecord[],
  required: readonly string[],
  onDate: string,
): VaccineStatus {
  const end = new Date(`${onDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 30);
  const soon = end.toISOString().slice(0, 10);
  const vaccines = [...new Set(required)].map((vaccine) => {
    const latest = records
      .filter((r) => r.vaccine === vaccine)
      .sort(
        (a, b) =>
          b.expires_on.localeCompare(a.expires_on) ||
          Number(!!b.verified_at) - Number(!!a.verified_at),
      )[0];
    const expiresOn = latest?.expires_on ?? null;
    const state: VaccineState = !expiresOn
      ? "missing"
      : expiresOn < onDate
        ? "expired"
        : expiresOn <= soon
          ? "expiring"
          : "ok";
    return {
      vaccine,
      state,
      expiresOn,
      unverified: latest?.source === "portal" && !latest.verified_at,
    };
  });
  return {
    vaccines,
    overall: vaccines.reduce<VaccineState>(
      (worst, r) => (severity[r.state] > severity[worst] ? r.state : worst),
      "ok",
    ),
  };
}

/** A portal upload nobody has verified is not current yet: it warns under
 *  either rule until the office verifies it. */
export function groomVaccineDecision(
  rule: VaccineRule,
  status: VaccineStatus,
): "allow" | "warn" | "block" {
  if (rule === "off") return "allow";
  if (status.vaccines.some((r) => r.state === "expired" || r.state === "missing"))
    return rule === "block" ? "block" : "warn";
  return status.vaccines.some((r) => r.unverified) ? "warn" : "allow";
}

/** Checks one pet on every date a plan lands on. The first groom follows the
 *  rule; a later groom that would lapse warns, because the record can still
 *  be renewed before that day and My Day checks it again on the day. */
export function groomVaccineCheck(
  records: readonly VaccineRecord[],
  required: readonly string[],
  rule: VaccineRule,
  dates: readonly string[],
): { decision: "allow" | "warn" | "block"; firstFlaggedOn: string | null } {
  const rank = { allow: 0, warn: 1, block: 2 } as const;
  let decision: "allow" | "warn" | "block" = "allow";
  let firstFlaggedOn: string | null = null;
  dates.forEach((date, i) => {
    const raw = groomVaccineDecision(rule, vaccineStatus(records, required, date));
    if (raw === "allow") return;
    const effective = i === 0 ? raw : "warn";
    firstFlaggedOn ??= date;
    if (rank[effective] > rank[decision]) decision = effective;
  });
  return { decision, firstFlaggedOn };
}

/** What a groomer is shown for one pet on one day. */
export type GroomVaccineFlag = "ok" | "expiring" | "expired" | "missing" | "unverified";
export function groomVaccineFlag(status: VaccineStatus): GroomVaccineFlag {
  if (status.overall === "expired" || status.overall === "missing") return status.overall;
  if (status.vaccines.some((r) => r.unverified)) return "unverified";
  return status.overall;
}

export const VACCINE_LABELS: Record<Vaccine, string> = {
  rabies: "Rabies",
  dhpp: "DHPP",
  bordetella: "Bordetella",
  leptospirosis: "Leptospirosis",
  canine_influenza: "Canine influenza",
  other: "Other",
};
export const VACCINE_STATUS_LABELS: Record<VaccineState, string> = {
  ok: "Up to date",
  expiring: "Expires soon",
  expired: "Expired",
  missing: "Missing",
};
export const VACCINE_BUCKET = "pet-vaccine-records";
export const VACCINE_MAX_BYTES = 10485760;
export const VACCINE_MIME_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
} as const;
export type VaccineMime = keyof typeof VACCINE_MIME_EXT;
