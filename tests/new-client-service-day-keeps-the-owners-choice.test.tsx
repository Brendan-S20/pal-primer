// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any -- mocks at the module edge */
// #1059: Service day follows First visit until the owner picks a day. A day
// they picked (here or in a restored draft) stays when First visit moves.

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
  addressSearchStatus: async () => ({ enabled: false }),
  autocompleteAddress: async () => ({ suggestions: [] }),
  resolveAddress: async () => null,
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
async function toPlan() {
  await type(el("#dn")!, "Jane Doe");
  for (let i = 0; i < 6 && !el("#started-on"); i++) {
    if (el("#st")) {
      for (const [id, v] of [
        ["#st", "2 Woodward Ave"],
        ["#ci", "Detroit"],
        ["#rg", "MI"],
        ["#pc", "48226"],
      ])
        await type(el(id)!, v);
    }
    const dog = [...host.querySelectorAll("label")].find((l) => l.textContent?.trim() === "Name");
    if (dog)
      await type(
        (document.getElementById(dog.htmlFor) ??
          dog.parentElement!.querySelector("input")) as HTMLInputElement,
        "Bailey",
      );
    await click("Continue");
  }
  expect(el("#started-on")).not.toBeNull();
}

const SERVICE_DAY = "fieldset";
const WALK_DAYS = '[aria-labelledby="nc-weekdays-label"]';
async function savedPlan() {
  // No zone or standard price in these fixtures, so the owner types one.
  const label = [...host.querySelectorAll("label")].find((l) =>
    l.textContent?.startsWith("Price per visit"),
  )!;
  await type(
    (document.getElementById(label.htmlFor) ??
      label.parentElement!.querySelector("input")) as HTMLInputElement,
    "25",
  );
  await click("Create client");
  const { startedOn, preferredWeekdays, weekdays } = h.sent.at(-1).subscription;
  return { startedOn, preferredWeekdays, weekdays };
}
const on = (scope = SERVICE_DAY) => [
  ...new Set(
    buttons(scope)
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent?.trim()),
  ),
];
const firstVisit = () => el("#started-on")!.value;

beforeEach(() => {
  localStorage.clear();
  h.walks = false;
  h.sent = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-25T15:00:00Z")); // Wednesday in Detroit
});
afterEach(async () => {
  await unmount();
  vi.useRealTimers();
});

describe("Service day follows First visit until the owner picks (#1059)", () => {
  it("follows Today, Tomorrow and the date field while untouched", async () => {
    await mount();
    await toPlan();
    expect([firstVisit(), on()]).toEqual(["2026-11-26", ["Thu"]]);
    await click("Today");
    expect([firstVisit(), on()]).toEqual(["2026-11-25", ["Wed"]]);
    await click("Tomorrow");
    expect(on()).toEqual(["Thu"]);
    await type(el("#started-on")!, "2026-11-28");
    expect(on()).toEqual(["Sat"]);
    expect(await savedPlan()).toEqual({ startedOn: "2026-11-28", preferredWeekdays: [6] });
  });

  it("keeps the owner's day when First visit moves", async () => {
    await mount();
    await toPlan();
    await click("Mon", SERVICE_DAY);
    await click("Today");
    expect([firstVisit(), on()]).toEqual(["2026-11-25", ["Mon"]]);
    await type(el("#started-on")!, "2026-11-28");
    expect(on()).toEqual(["Mon"]);
    expect(await savedPlan()).toEqual({ startedOn: "2026-11-28", preferredWeekdays: [1] });
  });

  it("keeps a restored draft's day when First visit moves", async () => {
    await mount();
    await toPlan();
    await click("Mon", SERVICE_DAY);
    await unmount();
    await mount();
    expect(on()).toEqual(["Mon"]);
    await click("Today");
    expect(on()).toEqual(["Mon"]);
  });

  it("keeps a walk plan's picked Days each week when First visit moves", async () => {
    h.walks = true;
    await mount();
    await toPlan();
    expect(on(WALK_DAYS)).toEqual(["Thu"]);
    await click("Today");
    expect(on(WALK_DAYS)).toEqual(["Wed"]);
    await click("Mon", WALK_DAYS);
    await type(el("#started-on")!, "2026-11-28");
    expect(on(WALK_DAYS)).toEqual(["Mon", "Wed"]);
    expect(await savedPlan()).toEqual({ startedOn: "2026-11-28", weekdays: [1, 3] });
  });
});
