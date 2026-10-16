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
      cents =
        fallbackPets > 0 && service.extra_pet_cents > 0
          ? service.extra_pet_cents
          : service.base_price_cents;
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
