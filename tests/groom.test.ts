import { describe, expect, it } from "vitest";
import {
  groomPetLabel,
  groomQuote,
  groomQuoteSummary,
  petSize,
  type GroomPet,
  type GroomRule,
  type GroomService,
} from "@/lib/groom";

describe("petSize", () => {
  for (const [size, spellings] of Object.entries({
    small: ["s", "sm", "small", " SMALL ", "S m"],
    medium: ["m", "med", "medium", " MEDIUM "],
    large: ["l", "lg", "large", " L G "],
    xlarge: ["xl", "x-large", "extra large", "giant", "xlarge", " X - LARGE ", "Extra Large"],
  })) {
    for (const spelling of spellings)
      it(`normalizes ${JSON.stringify(spelling)}`, () => {
        expect(petSize(spelling, 10)).toBe(size);
      });
  }
  it.each([
    [0.1, "small"],
    [20, "small"],
    [20.1, "medium"],
    [50, "medium"],
    [50.1, "large"],
    [90, "large"],
    [90.1, "xlarge"],
    [300, "xlarge"],
  ] as const)("uses %s lb when size is absent", (weight, expected) => {
    for (const value of [null, undefined, "", "  ", "imported text"])
      expect(petSize(value, weight)).toBe(expected);
  });
  it.each([null, undefined, 0, -1, NaN, Infinity])(
    "has no size without usable text or weight (%s)",
    (weight) => {
      expect(petSize("unknown", weight)).toBeNull();
    },
  );
  it("prefers an explicit size to a conflicting weight", () =>
    expect(petSize("small", 120)).toBe("small"));
});

const service: GroomService = {
  price_unit: "visit",
  base_price_cents: 7000,
  extra_pet_cents: 3000,
  default_duration_min: 75,
};
const bella: GroomPet = { id: "bella", name: "Bella", size: "small", coat_type: "short" };
const max: GroomPet = { id: "max", name: "Max", size: "xlarge", coat_type: "long" };
const rules: GroomRule[] = [
  { size: "small", coat_type: null, duration_min: 60, price_cents: 6000 },
  { size: "xlarge", coat_type: null, duration_min: 90, price_cents: 9500 },
];
const addon = {
  id: "teeth",
  name: "Teeth brushing",
  unit_price_cents: 1500,
  duration_min: 10,
  quantity: 1,
};
const quote = (pets: GroomPet[], overrides: Partial<Parameters<typeof groomQuote>[0]> = {}) =>
  groomQuote({ service, rules, pets, addons: [], ...overrides });

describe("groomQuote", () => {
  it("books the same service for 60 minutes for small and 90 for extra large, using each rule's price", () => {
    expect(quote([bella])).toMatchObject({
      minutes: 60,
      cents: 6000,
      pets: [
        { id: "bella", name: "Bella", size: "small", minutes: 60, cents: 6000, fromRule: true },
      ],
    });
    expect(quote([max])).toMatchObject({
      minutes: 90,
      cents: 9500,
      pets: [{ id: "max", name: "Max", size: "xlarge", minutes: 90, cents: 9500, fromRule: true }],
    });
    expect(quote([bella], { addons: [addon] })).toMatchObject({ minutes: 70, cents: 7500 });
    expect(quote([max], { addons: [addon] })).toMatchObject({ minutes: 100, cents: 11000 });
  });
  it("adds sequential pet durations and multiplies add-on minutes and cents by quantity", () => {
    expect(quote([bella, max], { addons: [{ ...addon, quantity: 2 }] })).toEqual({
      minutes: 170,
      cents: 18500,
      pets: [
        { id: "bella", name: "Bella", size: "small", minutes: 60, cents: 6000, fromRule: true },
        { id: "max", name: "Max", size: "xlarge", minutes: 90, cents: 9500, fromRule: true },
      ],
      addons: [{ id: "teeth", name: "Teeth brushing", quantity: 2, minutes: 20, cents: 3000 }],
    });
  });
  it("prefers the exact coat regardless of rule order", () => {
    const exact: GroomRule = {
      size: "xlarge",
      coat_type: "long",
      duration_min: 120,
      price_cents: 11000,
    };
    for (const ordered of [
      [...rules, exact],
      [exact, ...rules],
    ]) {
      expect(quote([max], { rules: ordered })).toMatchObject({ minutes: 120, cents: 11000 });
    }
  });
  it("uses any-coat for a missing or unmatched coat, never a different coat's rule", () => {
    expect(quote([{ ...max, coat_type: null }])).toMatchObject({ minutes: 90, cents: 9500 });
    expect(quote([max], { rules: [{ ...rules[1], coat_type: "wire" }] })).toMatchObject({
      minutes: 75,
      cents: 7000,
      pets: [{ fromRule: false }],
    });
  });
  it("counts only unmatched pets in the fallback price sequence", () => {
    const unknown = { ...bella, id: "unknown", size: null };
    const medium = { ...max, id: "medium", size: "medium" as const };
    expect(quote([bella, unknown, max, medium])).toMatchObject({
      minutes: 300,
      cents: 25500,
      pets: [{ cents: 6000 }, { cents: 7000 }, { cents: 9500 }, { cents: 3000 }],
    });
  });
  it.each([0, -1])(
    "uses base for every unmatched pet if extra-pet price is %s",
    (extra_pet_cents) => {
      expect(
        quote([bella, max], { rules: [], service: { ...service, extra_pet_cents } }),
      ).toMatchObject({ minutes: 150, cents: 14000 });
    },
  );
  it("propagates any missing required price while keeping the detail and length", () => {
    expect(
      quote([bella, max], { rules: [], service: { ...service, base_price_cents: null } }),
    ).toMatchObject({
      minutes: 150,
      cents: null,
      pets: [{ cents: null }, { cents: 3000 }],
    });
    expect(quote([bella, max], { service: { ...service, base_price_cents: null } }).cents).toBe(
      15500,
    );
  });
  it("keeps zero-price rules and zero-duration add-ons", () => {
    expect(
      quote([bella], {
        rules: [{ ...rules[0], price_cents: 0 }],
        addons: [{ ...addon, unit_price_cents: 0, duration_min: 0 }],
      }),
    ).toMatchObject({ minutes: 60, cents: 0 });
  });
  it("handles no pets, add-ons only, and a missing default length", () => {
    expect(quote([])).toEqual({ minutes: 0, cents: 0, pets: [], addons: [] });
    expect(quote([], { addons: [addon] })).toMatchObject({ minutes: 10, cents: 1500 });
    expect(
      quote([max], { rules: [], service: { ...service, default_duration_min: null } }),
    ).toMatchObject({ minutes: 0, cents: 7000 });
  });
  it("leaves its inputs unchanged", () => {
    const input = { service, rules, pets: [bella, max], addons: [addon] };
    const before = structuredClone(input);
    groomQuote(input);
    expect(input).toEqual(before);
  });
});

describe("invoice descriptions", () => {
  it("uses plain size labels and handles missing size and an empty pet list", () => {
    expect(groomPetLabel(bella)).toBe("Bella (small)");
    expect(groomPetLabel({ name: "Bella", size: null })).toBe("Bella");
    expect(groomQuoteSummary("Full groom", [bella, max])).toBe(
      "Full groom: Bella (small), Max (extra large)",
    );
    expect(groomQuoteSummary("Full groom", [])).toBe("Full groom");
  });
});

describe("groomQuote on an hourly service", () => {
  it("charges the hourly rate for a pet with no size rule", () => {
    const q = groomQuote({
      service: { price_unit: "hour", base_price_cents: 6000, extra_pet_cents: 0, default_duration_min: 90 },
      rules: [],
      pets: [{ id: "p1", name: "Bella", size: "small", coat_type: null }],
      addons: [],
    });
    expect(q.cents).toBe(9000);
    expect(q.minutes).toBe(90);
  });
});
