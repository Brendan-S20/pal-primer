// What the new-client wizard keeps on the device (useFormDraft, gaps-r2-12),
// and how a kept draft is read back (#784).
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
//
// The wizard's `restore` handed every stored field straight to its setter.
// A draft is JSON written by whatever build was live when it was typed, so a
// draft from an older build has no key for a field added since (and
// JSON.stringify drops a key whose value was `undefined`). Restoring one set
// that field to `undefined`, and Create client then called `.trim()` on it:
// "Create client did not finish. Cannot read properties of undefined
// (reading 'trim')", three times in a row, until the owner pressed Discard
// draft. #798 kept that message on screen; it did not stop it happening.
//
// ── THE RULE ──────────────────────────────────────────────────────────────
//
// A stored draft is untrusted input. Every field is taken from it only when it
// has the type the wizard holds; anything missing, null where null is not a
// value, or of the wrong type falls back to how the form opened. So a draft of
// any age, or one half-written, opens as a form the wizard can submit.

import { BLANK_DOG, type WizardDog } from "@/lib/lead-conversion";

export type NewClientDraftDog = WizardDog;

export type NewClientDraftPolygon = {
  type: "Polygon";
  coordinates: number[][][];
};

export type NewClientDraft = {
  step: number;
  groomInstead: boolean;
  displayName: string;
  accountType: "residential" | "commercial";
  primaryEmail: string;
  primaryPhone: string;
  officeNote: string;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  accessNotes: string;
  parkingNotes: string;
  hazardNotes: string;
  vcName: string;
  vcPhone: string;
  vcEmail: string;
  hz: Record<string, boolean>;
  boundary: NewClientDraftPolygon | null;
  geo: { lat: number; lng: number } | null;
  dogs: NewClientDraftDog[];
  frequency: "weekly" | "biweekly" | "twice_weekly" | "monthly" | "one_time";
  billingCadence: "postpaid" | "prepaid";
  unitCount: string;
  stationCount: string;
  priceOverride: string;
  skipPlan: boolean | null;
  startedOn: string;
  serviceDays: number[] | null;
  serviceId: string;
  weekdays: number[] | null;
  fcChoice: string;
  fcOverride: string;
};

const FREQUENCIES = ["weekly", "biweekly", "twice_weekly", "monthly", "one_time"] as const;
const TEMPERAMENTS = ["friendly", "nervous", "aggressive", "unknown"] as const;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const STRING_FIELDS = [
  "displayName",
  "primaryEmail",
  "primaryPhone",
  "officeNote",
  "street",
  "city",
  "region",
  "postalCode",
  "accessNotes",
  "parkingNotes",
  "hazardNotes",
  "vcName",
  "vcPhone",
  "vcEmail",
  "unitCount",
  "stationCount",
  "priceOverride",
  "serviceId",
  "fcChoice",
  "fcOverride",
] as const satisfies readonly (keyof NewClientDraft)[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function weekdayList(v: unknown, fallback: number[] | null): number[] | null {
  if (v === null) return null;
  if (!Array.isArray(v)) return fallback;
  if (!v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return fallback;
  return [...new Set(v as number[])];
}

function dog(v: unknown): NewClientDraftDog | null {
  if (!isRecord(v)) return null;
  const out: NewClientDraftDog = {
    ...BLANK_DOG,
    name: str(v.name, ""),
    breed: str(v.breed, ""),
    weightClass: str(v.weightClass, ""),
    temperament: oneOf(v.temperament, TEMPERAMENTS, BLANK_DOG.temperament),
    notes: str(v.notes, ""),
  };
  if (typeof v.coatType === "string") out.coatType = v.coatType as NewClientDraftDog["coatType"];
  if (typeof v.weightLb === "string") out.weightLb = v.weightLb;
  return out;
}

function polygon(v: unknown): NewClientDraftPolygon | null {
  if (!isRecord(v) || v.type !== "Polygon" || !Array.isArray(v.coordinates)) return null;
  const ok = v.coordinates.every(
    (ring) =>
      Array.isArray(ring) &&
      ring.every(
        (pt) => Array.isArray(pt) && pt.length >= 2 && pt.every((n) => Number.isFinite(n)),
      ),
  );
  return ok ? (v as NewClientDraftPolygon) : null;
}

function point(v: unknown): { lat: number; lng: number } | null {
  if (!isRecord(v)) return null;
  const { lat, lng } = v;
  return typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng)
    ? { lat, lng }
    : null;
}

/**
 * A stored draft, made safe to restore: every field the wizard holds, of the
 * type it holds, with `base` (how the form opened) wherever the draft has
 * nothing usable. `lastStep` is the index of the wizard's last step; a step
 * past it (a draft from a business that has since dropped a step) is clamped.
 *
 * Returns null when `raw` is not a draft at all.
 */
export function normalizeNewClientDraft(
  raw: unknown,
  base: NewClientDraft,
  lastStep: number,
): NewClientDraft | null {
  if (!isRecord(raw)) return null;
  const out: NewClientDraft = {
    ...base,
    hz: { ...base.hz },
    dogs: base.dogs.map((d) => ({ ...d })),
  };

  for (const k of STRING_FIELDS) out[k] = str(raw[k], base[k]);

  const step = raw.step;
  out.step =
    typeof step === "number" && Number.isInteger(step) && step >= 0
      ? Math.min(step, Math.max(0, lastStep))
      : base.step;
  out.groomInstead = typeof raw.groomInstead === "boolean" ? raw.groomInstead : base.groomInstead;
  out.accountType = oneOf(
    raw.accountType,
    ["residential", "commercial"] as const,
    base.accountType,
  );
  out.frequency = oneOf(raw.frequency, FREQUENCIES, base.frequency);
  out.billingCadence = oneOf(
    raw.billingCadence,
    ["postpaid", "prepaid"] as const,
    base.billingCadence,
  );

  if (isRecord(raw.hz)) {
    for (const key of Object.keys(base.hz)) {
      const v = raw.hz[key];
      if (typeof v === "boolean") out.hz[key] = v;
    }
  }

  out.boundary = raw.boundary === undefined ? base.boundary : polygon(raw.boundary);
  out.geo = raw.geo === undefined ? base.geo : point(raw.geo);

  if (Array.isArray(raw.dogs)) {
    const dogs = raw.dogs.map(dog).filter((d): d is NewClientDraftDog => d !== null);
    out.dogs = dogs.length ? dogs : [{ ...BLANK_DOG }];
  }

  out.skipPlan =
    raw.skipPlan === null || typeof raw.skipPlan === "boolean" ? raw.skipPlan : base.skipPlan;
  out.startedOn =
    typeof raw.startedOn === "string" && ISO_DAY.test(raw.startedOn)
      ? raw.startedOn
      : base.startedOn;
  out.serviceDays = weekdayList(raw.serviceDays, base.serviceDays);
  out.weekdays = weekdayList(raw.weekdays, base.weekdays);

  return out;
}
