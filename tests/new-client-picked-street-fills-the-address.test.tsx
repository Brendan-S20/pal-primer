// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any -- mocks at the module edge */
// #1059: picking a street suggestion on the new-client form fills City, State
// and ZIP. A place Google returns with no ZIP fills the rest, leaves ZIP empty
// and says so; a pick that fills nothing says so too. The real form and the
// real Google provider run here; only Google's replies are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ walks: false, sent: [] as any[] }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    const b: any = {};
    for (const k of ["middleware", "inputValidator", "validator", "server", "client"])
      b[k] = () => b;
    b.handler = () => async () => ({});
    return b;
  };
  return {
    useServerFn: (f: unknown) => f,
    createServerFn: builder,
    createMiddleware: builder,
    createServerOnlyFn: (f: unknown) => f,
    createIsomorphicFn: () => ({
      server: () => ({ client: (f: unknown) => f }),
      client: (f: unknown) => ({ server: () => f }),
    }),
  };
});
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useSearch: () => ({}) }),
  Link: (p: { children?: unknown }) => p.children,
  useNavigate: () => () => {},
}));
vi.mock("@/lib/org.functions", () => ({
  getMyOrg: async () => ({ organization: { id: "o1", timezone: "America/Detroit" } }),
}));
vi.mock("@/lib/address.functions", () => ({
  addressSearchStatus: async () => ({ enabled: true }),
  autocompleteAddress: async () => ({
    suggestions: [{ id: "place-3", mainText: "3 Woodward Avenue", secondaryText: "Detroit, MI" }],
  }),
  // What the server function does with the provider (its auth and zone lookup
  // aside): pass the request on, and refuse when no address comes back.
  resolveAddress: async ({ data }: any) => {
    const { googlePlacesProvider } = await import("@/lib/address/google-places.server");
    const address = await googlePlacesProvider.details(data.placeId, {
      allowMissingZip: data.allowMissingZip,
      suggestion: { mainText: data.mainText, secondaryText: data.secondaryText },
    });
    if (!address) throw new Error("Couldn't load that address. Enter it manually instead.");
    return { address, zoneId: null, zoneName: null };
  },
}));
vi.mock("@/lib/geocode.functions", () => ({ lookupAddressPoint: async () => ({ geo: null }) }));
vi.mock("@/lib/clients.functions", () => ({
  onboardClient: async (args: { data: unknown }) => {
    h.sent.push(args.data);
    return {};
  },
  getInternalQuote: async () => ({}),
}));
vi.mock("@/lib/first-cleanup.functions", () => ({
  getFirstCleanupPricing: async () => ({ pricing: null }),
}));
vi.mock("@/lib/leads.functions", () => ({
  getLeadForConversion: async () => null,
  linkLeadToExistingClient: async () => ({}),
}));
vi.mock("@/lib/quotes.functions", () => ({
  getQuote: async () => null,
  markQuoteConverted: async () => ({}),
}));
vi.mock("@/lib/notifications.functions", () => ({ getEmailSendStatus: async () => ({}) }));
vi.mock("@/lib/email-settings.functions", () => ({ getEmailSettings: async () => ({}) }));
vi.mock("@/lib/services.functions", () => ({
  listServices: async () => ({
    services: h.walks
      ? [
          {
            id: "walk",
            name: "30-minute walk",
            service_line: "dog_walking",
            active: true,
            base_price_cents: 2500,
            duration_minutes: 30,
            created_at: "2026-11-01T00:00:00Z",
          },
        ]
      : [],
  }),
}));
vi.mock("@/lib/offline/action-owner", () => ({ resolveOfflineUserId: async () => "u1" }));
vi.mock("@/hooks/useMyRole", () => ({
  useMyRole: () => ({ orgId: "o1" }),
  usePermissions: () => ({ can: () => true }),
}));
vi.mock("@/components/CommercialOnly", () => ({
  useServiceLines: () => ({
    petWaste: !h.walks,
    lines: [h.walks ? "dog_walking" : "pet_waste"],
    known: true,
  }),
  usePickerLines: () => undefined,
}));
vi.mock("@/components/BoundarySketch", () => ({
  BoundarySketch: () => null,
  formatArea: () => "",
}));

const { Route } = await import("@/routes/_authenticated/clients.new");
// Loaded up front so the first pick does not wait on a cold import.
await import("@/lib/address/google-places.server");

let root: Root;
let host: HTMLDivElement;

const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const Page = (Route as any).options.component;
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(Page))),
  );
  await settle();
}
async function unmount() {
  await act(async () => root.unmount());
  host.remove();
}
const el = (selector: string) => host.querySelector(selector) as HTMLInputElement | null;
const buttons = (scope = "") => [...host.querySelectorAll<HTMLButtonElement>(`${scope} button`)];
async function click(text: string, scope = "") {
  const b = buttons(scope).find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no "${text}" button`);
  await act(async () => b.click());
  await settle();
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}
function placeReply({ zip }: { zip: boolean }) {
  const part = (types: string, longText: string, shortText = longText) => ({
    types: [types],
    longText,
    shortText,
  });
  vi.stubGlobal("fetch", async () =>
    Response.json({
      addressComponents: [
        part("street_number", "3"),
        part("route", "Woodward Avenue", "Woodward Ave"),
        part("locality", "Detroit"),
        part("administrative_area_level_1", "Michigan", "MI"),
        ...(zip ? [part("postal_code", "48226")] : []),
      ],
      formattedAddress: zip ? "3 Woodward Ave, Detroit, MI 48226, USA" : undefined,
    }),
  );
}

/** Open the Property step, type a street and click the one suggestion. */
async function pickStreet(before?: () => Promise<void>) {
  await type(el("#dn")!, "Jane Doe");
  for (let i = 0; i < 3 && !el("#st"); i++) await click("Continue");
  await before?.();
  await act(async () => el("#st")!.focus());
  await type(el("#st")!, "3 Woodward Ave, Detroit");
  await act(async () => new Promise((r) => setTimeout(r, 400))); // search debounce
  const option = host.querySelector('[role="option"]');
  expect(option).not.toBeNull();
  await act(async () => {
    option!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
  await settle();
}
const boxes = () => ["#st", "#ci", "#rg", "#pc"].map((id) => el(id)!.value);
const said = () =>
  [...host.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "").join("");

beforeEach(async () => {
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key");
  localStorage.clear();
  sessionStorage.clear();
  await mount();
});
afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("new client: picking a street suggestion (#1059)", () => {
  it("fills street, city, state and ZIP from a complete place", async () => {
    placeReply({ zip: true });
    await pickStreet();
    expect(boxes()).toEqual(["3 Woodward Avenue", "Detroit", "MI", "48226"]);
    expect(said()).not.toContain("ZIP");
  });

  it("a place with no ZIP fills the rest, clears the old ZIP and asks for it", async () => {
    placeReply({ zip: false });
    await pickStreet(() => type(el("#pc")!, "99999"));
    expect(boxes()).toEqual(["3 Woodward Avenue", "Detroit", "MI", ""]);
    expect(said()).toContain("Add the ZIP.");
    await type(el("#pc")!, "48226");
    expect(said()).not.toContain("Add the ZIP.");
  });

  it("a pick that cannot fill the address keeps the typed text and says so", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 500 }));
    await pickStreet();
    expect(boxes()).toEqual(["3 Woodward Ave, Detroit", "", "", ""]);
    expect(said()).toContain("We couldn't fill in the rest of that address.");
  });
});

describe("other address forms are unchanged", () => {
  it("without the opt-in, a place with no ZIP is still refused", async () => {
    placeReply({ zip: false });
    const { googlePlacesProvider } = await import("@/lib/address/google-places.server");
    expect(await googlePlacesProvider.details("place-3")).toBeNull();
  });

  it("the server function accepts and forwards the opt-in", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/address.functions.ts", "utf8");
    expect(source).toContain("allowMissingZip: z.boolean().optional()");
    expect(source).toContain("allowMissingZip: data.allowMissingZip");
  });
});
