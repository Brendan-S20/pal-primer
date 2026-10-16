export const REQUIRED_VACCINES = ["rabies", "dhpp", "bordetella", "leptospirosis", "canine_influenza"] as const;
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
  vaccines: { vaccine: string; state: VaccineState; expiresOn: string | null; unverified: boolean }[];
  overall: VaccineState;
};
const severity: Record<VaccineState, number> = { ok: 0, expiring: 1, expired: 2, missing: 3 };

/** Calendar dates use UTC arithmetic so daylight saving does not shift the 30-day boundary. */
export function vaccineStatus(records: readonly VaccineRecord[], required: readonly string[], onDate: string): VaccineStatus {
  const end = new Date(`${onDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 30);
  const soon = end.toISOString().slice(0, 10);
  const vaccines = [...new Set(required)].map((vaccine) => {
    const latest = records.filter((r) => r.vaccine === vaccine)
      .sort((a, b) => b.expires_on.localeCompare(a.expires_on) || Number(!!b.verified_at) - Number(!!a.verified_at))[0];
    const expiresOn = latest?.expires_on ?? null;
    const state: VaccineState = !expiresOn ? "missing" : expiresOn < onDate ? "expired" : expiresOn <= soon ? "expiring" : "ok";
    return { vaccine, state, expiresOn, unverified: latest?.source === "portal" && !latest.verified_at };
  });
  return { vaccines, overall: vaccines.reduce<VaccineState>((worst, r) => severity[r.state] > severity[worst] ? r.state : worst, "ok") };
}

export function groomVaccineDecision(rule: VaccineRule, status: VaccineStatus): "allow" | "warn" | "block" {
  if (rule === "off" || !status.vaccines.some((r) => r.state === "expired" || r.state === "missing")) return "allow";
  return rule === "block" ? "block" : "warn";
}

export const VACCINE_LABELS: Record<Vaccine, string> = {
  rabies: "Rabies", dhpp: "DHPP", bordetella: "Bordetella", leptospirosis: "Leptospirosis", canine_influenza: "Canine influenza", other: "Other",
};
export const VACCINE_STATUS_LABELS: Record<VaccineState, string> = { ok: "Up to date", expiring: "Expires soon", expired: "Expired", missing: "Missing" };
export const VACCINE_BUCKET = "pet-vaccine-records";
export const VACCINE_MAX_BYTES = 10485760;
export const VACCINE_MIME_EXT = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "application/pdf": "pdf",
} as const;
export type VaccineMime = keyof typeof VACCINE_MIME_EXT;
