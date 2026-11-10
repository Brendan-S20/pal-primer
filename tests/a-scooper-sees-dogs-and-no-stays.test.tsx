// Pet sitting (#411) adds a species picker, a Pets heading, care
// instructions and a Stays section to the client page. A business that does
// not run pet sitting must see the dog list it saw before, and no Stays.

import { describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const lines = vi.hoisted(() => ({ current: ["pet_waste"] as string[] }));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (f: unknown) => f,
  createMiddleware: () => ({ server: () => ({}) }),
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    const chain: any = {
      middleware: () => chain,
      inputValidator: () => chain,
      handler: () => vi.fn(),
    };
    return chain;
  },
}));
vi.mock("@/components/CommercialOnly", () => ({
  useServiceLines: () => ({
    lines: lines.current,
    petWaste: lines.current.includes("pet_waste"),
    known: true,
  }),
}));
vi.mock("@/lib/dogs.functions", () => ({ addDog: vi.fn(), updateDog: vi.fn() }));
vi.mock("@/lib/stays.functions", () => ({
  getPetCare: vi.fn(),
  setPetCare: vi.fn(),
  createStay: vi.fn(),
  listStaysForClient: vi.fn(),
  cancelStay: vi.fn(),
  setStaySitter: vi.fn(),
}));
vi.mock("@/lib/stay-booking.functions", () => ({ confirmStay: vi.fn() }));
// Booking a stay is the 'booking' permission (#411 on #616's terms): an owner.
vi.mock("@/hooks/useMyRole", () => ({
  usePermissions: () => ({ can: () => true, role: "owner", loading: false }),
}));
vi.mock("@/lib/clients.functions", () => ({ listDogsForClient: vi.fn() }));
vi.mock("@/lib/properties.functions", () => ({
  listPropertiesForClient: vi.fn(),
  setPropertyArchived: vi.fn(),
  deletePropertyIfNoHistory: vi.fn(),
}));
vi.mock("@/lib/visits.functions", () => ({ listStaff: vi.fn() }));
vi.mock("@/lib/services.functions", () => ({ listServices: vi.fn() }));
vi.mock("@/lib/org.functions", () => ({ getMyOrg: vi.fn() }));
vi.mock("@/components/client-detail/PropertyDrawer", () => ({ PropertyDrawer: () => null }));
vi.mock("@/components/BoundaryPreview", () => ({ BoundaryPreview: () => null }));
vi.mock("@/components/BoundarySketch", () => ({ formatArea: () => "" }));

import { DogsSection } from "@/components/client-detail/PropertiesTab";
import { StaysSection } from "@/components/client-detail/StaysSection";

const pets = [
  {
    id: "d1",
    property_id: "p1",
    name: "Biscuit",
    species: "dog",
    temperament: "friendly",
    active: true,
  },
  { id: "d2", property_id: "p1", name: "Rex", temperament: "unknown", active: true },
  {
    id: "c1",
    property_id: "p1",
    name: "Miso",
    species: "cat",
    temperament: "unknown",
    active: true,
  },
];
const dogsOnly = pets.filter((p) => p.species !== "cat");

function render(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  // Without React's text separators, so "Dogs (2)" reads as one string.
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>{node}</QueryClientProvider>,
  ).replace(/<!-- -->/g, "");
}

describe("a business that does not run pet sitting", () => {
  for (const business of [["pet_waste"], ["dog_walking"], ["pet_waste", "dog_walking"]]) {
    it(`${business.join(" + ")}: the dog list, as before`, () => {
      lines.current = business;
      const html = render(<DogsSection propertyId="p1" clientId="c" dogs={dogsOnly} />);
      expect(html).toContain("Dogs (2)");
      expect(html).toContain("Add dog");
      expect(html).toContain("Biscuit");
      expect(html).toContain("Rex");
      expect(html).not.toContain("Pets (");
      expect(html).not.toContain("Kind of pet");
      expect(html).not.toMatch(/>Care</);
    });

    it(`${business.join(" + ")}: no Stays section`, () => {
      lines.current = business;
      const html = render(
        <StaysSection
          clientId="c"
          client={{ account_type: "residential" }}
          properties={[{ id: "p1", street: "1 Main" }]}
          pets={dogsOnly}
          canManagePricing
        />,
      );
      expect(html).toBe("");
    });
  }

  it("still says how many dogs a plan should bill for, not counting a cat", () => {
    lines.current = ["pet_waste"];
    const html = render(
      <DogsSection propertyId="p1" clientId="c" dogs={pets} billedDogCounts={[3]} />,
    );
    expect(html).toContain("this property has 2 active dog record");
  });
});

describe("a business that runs pet sitting", () => {
  it("calls them Pets, names a cat, and offers care", () => {
    lines.current = ["pet_sitting"];
    const html = render(<DogsSection propertyId="p1" clientId="c" dogs={pets} />);
    expect(html).toContain("Pets (3)");
    expect(html).toContain("Add pet");
    expect(html).toMatch(/>Cat</);
    expect(html).toMatch(/>Care</);
  });

  it("draws the Stays section with a Book a stay button", () => {
    lines.current = ["pet_waste", "pet_sitting"];
    const html = render(
      <StaysSection
        clientId="c"
        client={{ account_type: "residential" }}
        properties={[{ id: "p1", street: "1 Main" }]}
        pets={pets}
        canManagePricing
      />,
    );
    expect(html).toContain("Stays");
    expect(html).toContain("Book a stay");
  });

  it("does not offer a stay to a commercial account", () => {
    lines.current = ["pet_sitting"];
    const html = render(
      <StaysSection
        clientId="c"
        client={{ account_type: "commercial" }}
        properties={[{ id: "p1", street: "1 Main" }]}
        pets={pets}
        canManagePricing
      />,
    );
    expect(html).not.toContain("Book a stay");
  });
});
