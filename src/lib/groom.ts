export const PET_SIZES = ["small", "medium", "large", "xlarge"] as const;
export type PetSize = (typeof PET_SIZES)[number];
export const PET_SIZE_LABEL: Record<PetSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xlarge: "Extra large",
};
export const COAT_TYPES = ["short", "medium", "long", "double", "curly", "wire"] as const;
export type CoatType = (typeof COAT_TYPES)[number];
export const COAT_LABEL: Record<CoatType, string> = {
  short: "Short coat",
  medium: "Medium coat",
  long: "Long coat",
  double: "Double coat",
  curly: "Curly coat",
  wire: "Wire coat",
};

/** Imports keep their original size text. Quotes use this normalized size. */
export function petSize(
  weight_class: string | null | undefined,
  weight_lb?: number | null,
): PetSize | null {
  const value = weight_class?.toLowerCase().replace(/[\s-]+/g, "") ?? "";
  if (["s", "sm", "small"].includes(value)) return "small";
  if (["m", "med", "medium"].includes(value)) return "medium";
  if (["l", "lg", "large"].includes(value)) return "large";
  if (["xl", "xlarge", "extralarge", "giant"].includes(value)) return "xlarge";
  if (weight_lb == null || !Number.isFinite(weight_lb) || weight_lb <= 0) return null;
  if (weight_lb <= 20) return "small";
  if (weight_lb <= 50) return "medium";
  if (weight_lb <= 90) return "large";
  return "xlarge";
}

export type GroomRule = {
  size: PetSize;
  coat_type: CoatType | null;
  duration_min: number;
  price_cents: number;
};
export type GroomPet = {
  id: string;
  name: string;
  size: PetSize | null;
  coat_type: CoatType | null;
};
export type GroomAddon = {
  id: string;
  name: string;
  unit_price_cents: number;
  duration_min: number;
  quantity: number;
};
export type GroomService = {
  price_unit: "visit" | "hour" | "night";
  base_price_cents: number | null;
  extra_pet_cents: number;
  default_duration_min: number | null;
};

/** Rule prices are per pet. Only pets without a rule share the fallback pricing sequence. */
export function groomQuote({
  service,
  rules,
  pets,
  addons,
}: {
  service: GroomService;
  rules: readonly GroomRule[];
  pets: readonly GroomPet[];
  addons: readonly GroomAddon[];
}) {
  let fallbackPets = 0;
  const quotedPets = pets.map((pet) => {
    const rule =
      pet.size == null
        ? undefined
        : (rules.find((r) => r.size === pet.size && r.coat_type === pet.coat_type) ??
          rules.find((r) => r.size === pet.size && r.coat_type === null));
    let cents: number | null;
    if (rule) cents = rule.price_cents;
    else {
      const perUnit =
        fallbackPets > 0 && service.extra_pet_cents > 0
          ? service.extra_pet_cents
          : service.base_price_cents;
      // An hourly service charges its rate for the pet's minutes; a size rule
      // is always a price per pet.
      const minutes = service.default_duration_min;
      cents =
        perUnit === null
          ? null
          : service.price_unit === "hour"
            ? minutes && minutes > 0
              ? Math.round((perUnit * minutes) / 60)
              : null
            : perUnit;
      fallbackPets += 1;
    }
    return {
      id: pet.id,
      name: pet.name,
      size: pet.size,
      minutes: rule?.duration_min ?? service.default_duration_min ?? 0,
      cents,
      fromRule: Boolean(rule),
    };
  });
  const quotedAddons = addons.map((a) => ({
    id: a.id,
    name: a.name,
    quantity: a.quantity,
    minutes: a.duration_min * a.quantity,
    cents: a.unit_price_cents * a.quantity,
  }));
  const rows = [...quotedPets, ...quotedAddons];
  return {
    minutes: rows.reduce((sum, row) => sum + row.minutes, 0),
    cents: rows.some((row) => row.cents === null)
      ? null
      : rows.reduce((sum, row) => sum + (row.cents ?? 0), 0),
    pets: quotedPets,
    addons: quotedAddons,
  };
}

export function groomPetLabel(pet: Pick<GroomPet, "name" | "size">): string {
  return pet.size ? `${pet.name} (${PET_SIZE_LABEL[pet.size].toLowerCase()})` : pet.name;
}

export function groomQuoteSummary(
  serviceName: string,
  pets: readonly Pick<GroomPet, "name" | "size">[],
): string {
  return pets.length ? `${serviceName}: ${pets.map(groomPetLabel).join(", ")}` : serviceName;
}

/** What the plan stores and every generated visit shows: the pets, then the add-ons. */
export function groomPlanSummary(
  serviceName: string,
  pets: readonly Pick<GroomPet, "name" | "size">[],
  addons: readonly { name: string; quantity: number }[],
): string {
  const base = groomQuoteSummary(serviceName, pets);
  const extras = addons
    .filter((a) => a.quantity > 0)
    .map((a) => (a.quantity > 1 ? `${a.name} x${a.quantity}` : a.name));
  return (extras.length ? `${base} + ${extras.join(", ")}` : base).slice(0, 240);
}

/** Setup and cleanup minutes when the business has not set its own. */
export const DEFAULT_GROOM_BUFFER_MIN = 15;
/** The span the open-time list covers. A start outside it can still be typed. */
export const GROOM_DAY_START = "07:00";
export const GROOM_DAY_END = "19:00";
export const GROOM_SLOT_STEP_MIN = 15;

/** The appointment's full hold: the quote plus setup and cleanup. */
export function groomHoldMinutes(quoteMinutes: number, bufferMin: number | null | undefined) {
  const buffer =
    bufferMin == null || !Number.isFinite(bufferMin) || bufferMin < 0
      ? DEFAULT_GROOM_BUFFER_MIN
      : Math.round(bufferMin);
  return quoteMinutes + buffer;
}

/** "09:30" or "09:30:00" to minutes after midnight. */
export function clockMinutes(value: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function clockLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export type BookedGroom = { start: string; minutes: number; summary?: string | null };

/** The booked grooms that share any minute with [start, start + minutes). */
export function groomClashes(
  start: string,
  minutes: number,
  booked: readonly BookedGroom[],
): BookedGroom[] {
  const from = clockMinutes(start);
  if (from == null) return [];
  const to = from + minutes;
  return booked.filter((b) => {
    const s = clockMinutes(b.start);
    if (s == null || !(b.minutes > 0)) return false;
    return s < to && from < s + b.minutes;
  });
}

/** Start times on the step where an appointment this long fits between the booked grooms. */
export function openGroomStarts(
  minutes: number,
  booked: readonly BookedGroom[],
  dayStart = GROOM_DAY_START,
  dayEnd = GROOM_DAY_END,
  step = GROOM_SLOT_STEP_MIN,
): string[] {
  const first = clockMinutes(dayStart) ?? 0;
  const last = clockMinutes(dayEnd) ?? 24 * 60;
  if (!(minutes > 0)) return [];
  const out: string[] = [];
  for (let t = first; t + minutes <= last; t += step) {
    const label = clockLabel(t);
    if (groomClashes(label, minutes, booked).length === 0) out.push(label);
  }
  return out;
}

/** The dates a plan lands on from `first`, every N weeks, through `days` later. */
export function groomRepeatDates(first: string, everyWeeks: number | null, days: number): string[] {
  if (everyWeeks == null || everyWeeks < 1) return [first];
  const out: string[] = [];
  const start = new Date(`${first}T00:00:00Z`);
  for (let offset = 0; offset <= days; offset += everyWeeks * 7) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + offset);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** The note stored on the visit. Labels come from the tech's language. */
export function composeGroomNote(parts: {
  coatLabel: string;
  coat: string;
  behaviorLabel: string;
  behavior: string;
  note: string;
}): string {
  const lines: string[] = [];
  const coat = parts.coat.trim();
  const behavior = parts.behavior.trim();
  const note = parts.note.trim();
  if (coat) lines.push(`${parts.coatLabel} ${coat}`);
  if (behavior) lines.push(`${parts.behaviorLabel} ${behavior}`);
  if (note) lines.push(note);
  return lines.join("\n").slice(0, 1000);
}
