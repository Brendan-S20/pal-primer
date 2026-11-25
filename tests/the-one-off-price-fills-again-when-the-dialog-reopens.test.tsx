// @vitest-environment happy-dom
//
// #1011 item 1 came in with #1051: for someone who sets prices, the one-off
// dialog fills the price box from the set price. The reset-per-opening effect
// then clears it on every open, and the fill effect did not run again when the
// cached price had not changed, so the SECOND open showed a blank price, the
// hint "Enter a price to book the visit", and a greyed Book button.
//
// These render the real dialog. The server functions are mocked at the module
// edge; the dialog, its effects and react-query's cache are the real ones.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  notifyManager,
  onlineManager,
} from "@tanstack/react-query";
import { OneOffVisitDialog } from "@/components/OneOffVisitDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLIENT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT_B = "bbbbbbbb-0000-4000-8000-000000000002";
const PROP_A = "a1a1a1a1-0000-4000-8000-000000000001";
const PROP_B1 = "b1b1b1b1-0000-4000-8000-000000000001";
const PROP_B2 = "b2b2b2b2-0000-4000-8000-000000000002";
const WASTE = "55555555-0000-4000-8000-000000000001";
const WALK = "55555555-0000-4000-8000-000000000002";

type Price = { cents: number | null; reason?: string };
const h = vi.hoisted(() => ({
  perms: new Set<string>(),
  price: vi.fn(
    async (_a: { data: { propertyId: string; serviceId?: string } }): Promise<unknown> => ({
      cents: null,
    }),
  ),
  // Every render of the Book button while recording: was it greyed?
  recording: false,
  bookRenders: [] as boolean[],
  create: vi.fn(async (_a: { data: Record<string, unknown> }): Promise<unknown> => ({
    ok: true,
    visitId: "v1",
  })),
}));

vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@tanstack/react-router", () => ({
  Link: (p: { children?: unknown }) => p.children,
}));
vi.mock("@/hooks/useOrgToday", () => ({ useOrgToday: () => "2026-11-25" }));
vi.mock("@/hooks/useMyRole", () => ({
  usePermissions: () => ({
    can: (p: string) => h.perms.has(p),
    role: "owner",
    loading: false,
    permissions: [...h.perms],
  }),
}));
vi.mock("@/components/ui/button", async (orig) => {
  const m = await orig<typeof import("@/components/ui/button")>();
  return {
    ...m,
    Button: (p: { children?: unknown; disabled?: boolean }) => {
      if (h.recording && /Book the visit|Booking/.test(String(p.children)))
        h.bookRenders.push(!!p.disabled);
      return createElement(m.Button as never, p as never);
    },
  };
});
vi.mock("@/components/CommercialOnly", () => ({ usePickerLines: () => undefined }));
vi.mock("@/components/ClientSearchPicker", () => ({ ClientSearchPicker: () => null }));
vi.mock("@/lib/properties.functions", () => ({
  listPropertiesForClient: async ({ data }: { data: { clientId: string } }) => ({
    properties:
      data.clientId === CLIENT_A
        ? [{ id: PROP_A, street: "1 Alpha St", label: null, archived_at: null }]
        : [
            { id: PROP_B1, street: "2 Beta St", label: null, archived_at: null },
            { id: PROP_B2, street: "3 Gamma St", label: null, archived_at: null },
          ],
  }),
}));
vi.mock("@/lib/services.functions", () => ({
  listServices: async () => ({
    services: [
      { id: WASTE, name: "Pet waste removal", service_line: "pet_waste", active: true },
      { id: WALK, name: "Dog walk", service_line: "dog_walking", active: true },
    ],
  }),
}));
vi.mock("@/lib/visits.functions", () => ({
  listStaff: async () => ({ staff: [] }),
  oneOffSetPrice: (a: { data: { propertyId: string; serviceId?: string } }) => h.price(a),
  createOneOffVisit: (a: { data: Record<string, unknown> }) => h.create(a),
}));
vi.mock("@/lib/server-outcome", () => ({
  toastServerError: () => {},
  toastServerOutcome: () => "ok",
}));

let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;

type Props = { open: boolean; clientId?: string };
async function show(p: Props) {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(OneOffVisitDialog, {
          open: p.open,
          clientId: p.clientId,
          onOpenChange: () => {},
        }),
      ),
    );
  });
  await settle();
}
/** Let react-query's promises and the effects they trigger run. */
async function settle() {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
}

const priceBox = () => document.body.querySelector<HTMLInputElement>("#oo-price");
const why = () => document.body.querySelector("[data-one-off-why-disabled]")?.textContent ?? null;
const bookButton = () =>
  [...document.body.querySelectorAll("button")].find((b) =>
    /Book the visit|Booking/.test(b.textContent ?? ""),
  )!;

async function typePrice(value: string) {
  const el = priceBox()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(id: string, value: string) {
  const el = document.body.querySelector<HTMLSelectElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

/** Price by property and service; anything not listed has no set price. */
function prices(table: Record<string, Price>) {
  h.price.mockImplementation(
    async ({ data }) =>
      table[`${data.propertyId}|${data.serviceId}`] ?? { cents: null, reason: "none" },
  );
}

beforeEach(() => {
  // The set-price lookup runs for someone who sets prices only if they can also
  // change settings (the "where is it set" link); see the PR's known gap.
  h.perms = new Set(["manage_pricing", "manage_settings"]);
  h.price.mockReset();
  h.create.mockReset();
  h.create.mockResolvedValue({ ok: true, visitId: "v1" });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("a fixed client with one property, for someone who sets prices", () => {
  beforeEach(() => prices({ [`${PROP_A}|${WASTE}`]: { cents: 5000 } }));

  it("shows the set price on the first open", async () => {
    await show({ open: true, clientId: CLIENT_A });
    expect(priceBox()!.value).toBe("50.00");
    expect(why()).toBeNull();
    expect(bookButton().disabled).toBe(false);
  });

  it("shows the set price again when the dialog is closed and reopened", async () => {
    await show({ open: true, clientId: CLIENT_A });
    await show({ open: false, clientId: CLIENT_A });
    await show({ open: true, clientId: CLIENT_A });
    expect(priceBox()!.value).toBe("50.00");
    expect(why()).toBeNull();
    expect(bookButton().disabled).toBe(false);
  });

  it("keeps a typed price while the dialog stays open", async () => {
    await show({ open: true, clientId: CLIENT_A });
    await typePrice("65.00");
    await show({ open: true, clientId: CLIENT_A });
    await settle();
    expect(priceBox()!.value).toBe("65.00");
    await qc.invalidateQueries({ queryKey: ["one-off-set-price"] });
    await settle();
    expect(priceBox()!.value).toBe("65.00");
  });

  it("keeps a cleared price blank rather than filling it back in", async () => {
    await show({ open: true, clientId: CLIENT_A });
    await typePrice("");
    await qc.invalidateQueries({ queryKey: ["one-off-set-price"] });
    await settle();
    expect(priceBox()!.value).toBe("");
    expect(bookButton().disabled).toBe(true);
  });

  it("starts a fresh open from the set price, not from what was typed last time", async () => {
    await show({ open: true, clientId: CLIENT_A });
    await typePrice("77.00");
    await show({ open: false, clientId: CLIENT_A });
    await show({ open: true, clientId: CLIENT_A });
    expect(priceBox()!.value).toBe("50.00");
  });

  it("books at the price on screen after a reopen", async () => {
    await show({ open: true, clientId: CLIENT_A });
    await show({ open: false, clientId: CLIENT_A });
    await show({ open: true, clientId: CLIENT_A });
    await act(async () => bookButton().click());
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0][0].data).toMatchObject({ propertyId: PROP_A, priceCents: 5000 });
  });
});

describe("a price from another property or service is never shown or booked", () => {
  const key = (p: string, s: string) => `${p}|${s}`;

  it("switching service shows the new service's price, and blank while it loads or has none", async () => {
    let release!: (p: Price) => void;
    h.price.mockImplementation(async ({ data }) => {
      if (data.serviceId === WALK) return new Promise<Price>((r) => (release = r));
      return { cents: 5000 };
    });
    await show({ open: true, clientId: CLIENT_A });
    expect(priceBox()!.value).toBe("50.00");

    await choose("oo-service", WALK);
    // The new price is still loading: the old one must not sit in the box.
    expect(priceBox()!.value).toBe("");
    expect(bookButton().disabled).toBe(true);

    await act(async () => release({ cents: null, reason: "none" }));
    await settle();
    expect(priceBox()!.value).toBe(""); // null price: blank, not the other service's
    expect(bookButton().disabled).toBe(true);

    await choose("oo-service", WASTE);
    expect(priceBox()!.value).toBe("50.00");
  });

  it("switching service to one with a price shows that price", async () => {
    prices({ [key(PROP_A, WASTE)]: { cents: 5000 }, [key(PROP_A, WALK)]: { cents: 3000 } });
    await show({ open: true, clientId: CLIENT_A });
    await choose("oo-service", WALK);
    expect(priceBox()!.value).toBe("30.00");
    await act(async () => bookButton().click());
    expect(h.create.mock.calls[0][0].data).toMatchObject({ serviceId: WALK, priceCents: 3000 });
  });

  it("switching property never shows or books the other property's price", async () => {
    let release!: (p: Price) => void;
    h.price.mockImplementation(async ({ data }) => {
      if (data.propertyId === PROP_B1) return { cents: 4000 };
      return new Promise<Price>((r) => (release = r));
    });
    await show({ open: true, clientId: CLIENT_B });
    await choose("oo-property", PROP_B1);
    expect(priceBox()!.value).toBe("40.00");

    await choose("oo-property", PROP_B2);
    expect(priceBox()!.value).toBe("");
    expect(bookButton().disabled).toBe(true);

    await act(async () => release({ cents: null, reason: "none" }));
    await settle();
    expect(priceBox()!.value).toBe("");
    expect(bookButton().disabled).toBe(true);
  });

  it("reopening for a different client starts clean: no other client's property or price", async () => {
    prices({
      [key(PROP_A, WASTE)]: { cents: 5000 },
      [key(PROP_B1, WASTE)]: { cents: 4000 },
      [key(PROP_B2, WASTE)]: { cents: 3500 },
    });
    await show({ open: true, clientId: CLIENT_A });
    expect(priceBox()!.value).toBe("50.00");
    await show({ open: false, clientId: CLIENT_A });

    await show({ open: true, clientId: CLIENT_B }); // two properties: nothing picked yet
    expect(document.body.querySelector<HTMLSelectElement>("#oo-property")!.value).toBe("");
    expect(priceBox()!.value).toBe("");
    expect(bookButton().disabled).toBe(true);

    await choose("oo-property", PROP_B2);
    expect(priceBox()!.value).toBe("35.00");
    await act(async () => bookButton().click());
    expect(h.create.mock.calls[0][0].data).toMatchObject({
      clientId: CLIENT_B,
      propertyId: PROP_B2,
      priceCents: 3500,
    });
  });
});

// ── The old price is not bookable while the set price is being fetched again ──
//
// These use controlled deferred promises (no timers): every call to the set-price
// function waits until the test resolves or rejects it. react-query's own
// notification scheduling is switched to microtasks for these tests.
describe("an untouched price is not bookable while its set price is refetched", () => {
  type Call = {
    propertyId: string;
    serviceId?: string;
    resolve: (p: Price) => void;
    reject: (e: Error) => void;
  };
  let calls: Call[] = [];
  const last = () => calls[calls.length - 1];

  beforeEach(() => {
    notifyManager.setScheduler((cb) => queueMicrotask(cb));
    calls = [];
    h.price.mockImplementation(
      ({ data }) =>
        new Promise<Price>((resolve, reject) => calls.push({ ...data, resolve, reject })),
    );
  });
  afterEach(() => {
    notifyManager.setScheduler((cb) => setTimeout(cb, 0));
    onlineManager.setOnline(true);
    h.recording = false;
  });

  async function flush() {
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
  }
  async function render(p: Props) {
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(OneOffVisitDialog, {
            open: p.open,
            clientId: p.clientId,
            onOpenChange: () => {},
          }),
        ),
      );
    });
    await flush();
  }
  async function answer(c: Call, p: Price) {
    await act(async () => c.resolve(p));
    await flush();
  }
  async function fail(c: Call) {
    await act(async () => c.reject(new Error("network down")));
    await flush();
  }
  function record() {
    h.bookRenders = [];
    h.recording = true;
  }
  /** Every render since record() had Book greyed (and there was at least one). */
  const neverBookable = () => h.bookRenders.length > 0 && h.bookRenders.every((d) => d);
  async function book() {
    await act(async () => bookButton().click());
    return h.create.mock.calls.at(-1)![0].data;
  }

  it("reopen: the old 50.00 is not bookable until the refreshed 60.00 arrives, and 6000 is sent", async () => {
    await render({ open: true, clientId: CLIENT_A });
    await answer(last(), { cents: 5000 });
    expect(priceBox()!.value).toBe("50.00");
    await render({ open: false, clientId: CLIENT_A });

    record();
    await render({ open: true, clientId: CLIENT_A }); // cached 5000, refetch in flight
    expect(calls).toHaveLength(2);
    expect(bookButton().disabled).toBe(true);
    expect(priceBox()!.value).not.toBe("50.00");
    expect(neverBookable()).toBe(true); // including the renders between reopen and the fetch

    await answer(last(), { cents: 6000 });
    expect(priceBox()!.value).toBe("60.00");
    expect(bookButton().disabled).toBe(false);
    expect((await book()).priceCents).toBe(6000);
  });

  it("switching back to a cached property: the old price is not bookable until the refreshed one arrives", async () => {
    await render({ open: true, clientId: CLIENT_B });
    await act(async () => {});
    await choose("oo-property", PROP_B1);
    await answer(last(), { cents: 5000 });
    await choose("oo-property", PROP_B2);
    await answer(last(), { cents: 4000 });
    expect(priceBox()!.value).toBe("40.00");

    record();
    await choose("oo-property", PROP_B1); // B1 is cached at 5000; fetch in flight
    expect(last().propertyId).toBe(PROP_B1);
    expect(bookButton().disabled).toBe(true);
    expect(priceBox()!.value).not.toBe("50.00");
    expect(priceBox()!.value).not.toBe("40.00");
    expect(neverBookable()).toBe(true);

    await answer(last(), { cents: 6000 });
    expect(priceBox()!.value).toBe("60.00");
    expect(bookButton().disabled).toBe(false);
    expect(await book()).toMatchObject({ propertyId: PROP_B1, priceCents: 6000 });
  });

  it("switching back to a cached service: the old price is not bookable until the refreshed one arrives", async () => {
    await render({ open: true, clientId: CLIENT_A });
    await answer(last(), { cents: 5000 }); // WASTE
    await choose("oo-service", WALK);
    await answer(last(), { cents: 3000 });
    expect(priceBox()!.value).toBe("30.00");

    record();
    await choose("oo-service", WASTE); // cached 5000; fetch in flight
    expect(last().serviceId).toBe(WASTE);
    expect(bookButton().disabled).toBe(true);
    expect(priceBox()!.value).not.toBe("50.00");
    expect(neverBookable()).toBe(true);

    await answer(last(), { cents: 6000 });
    expect(priceBox()!.value).toBe("60.00");
    expect(bookButton().disabled).toBe(false);
    expect(await book()).toMatchObject({ serviceId: WASTE, priceCents: 6000 });
  });

  it("a typed price stays, and stays bookable, during a refetch and after it", async () => {
    await render({ open: true, clientId: CLIENT_A });
    await answer(last(), { cents: 5000 });
    await typePrice("65.00");
    record();
    await act(async () => {
      void qc.invalidateQueries({ queryKey: ["one-off-set-price"] });
    });
    await flush();
    expect(calls).toHaveLength(2);
    expect(priceBox()!.value).toBe("65.00");
    expect(bookButton().disabled).toBe(false);
    expect(h.bookRenders.every((d) => !d)).toBe(true);
    await answer(last(), { cents: 7000 });
    expect(priceBox()!.value).toBe("65.00");
    expect((await book()).priceCents).toBe(6500);
  });

  it("a deliberately cleared price stays blank through a refetch", async () => {
    await render({ open: true, clientId: CLIENT_A });
    await answer(last(), { cents: 5000 });
    await typePrice("");
    await act(async () => {
      void qc.invalidateQueries({ queryKey: ["one-off-set-price"] });
    });
    await flush();
    expect(priceBox()!.value).toBe("");
    await answer(last(), { cents: 7000 });
    expect(priceBox()!.value).toBe("");
    expect(bookButton().disabled).toBe(true);
  });

  it("a failed refetch: the old price is not bookable, a plain hint shows, and typing works", async () => {
    await render({ open: true, clientId: CLIENT_A });
    await answer(last(), { cents: 5000 });
    await render({ open: false, clientId: CLIENT_A });
    record();
    await render({ open: true, clientId: CLIENT_A });
    await fail(last());
    expect(neverBookable()).toBe(true);
    expect(priceBox()!.value).toBe("");
    expect(bookButton().disabled).toBe(true);
    expect(why()).toBe("Enter a price to book the visit.");

    await typePrice("55.00");
    expect(bookButton().disabled).toBe(false);
    expect((await book()).priceCents).toBe(5500);
  });

  it("offline (the fetch is paused): the old price is not bookable, and typing works", async () => {
    await render({ open: true, clientId: CLIENT_A });
    await answer(last(), { cents: 5000 });
    await render({ open: false, clientId: CLIENT_A });
    onlineManager.setOnline(false);
    record();
    await render({ open: true, clientId: CLIENT_A });
    expect(calls).toHaveLength(1); // nothing was sent: the fetch is paused
    expect(neverBookable()).toBe(true);
    expect(bookButton().disabled).toBe(true);
    expect(why()).toBe("Enter a price to book the visit.");

    await typePrice("58.00");
    expect(bookButton().disabled).toBe(false);
    // Booking itself waits for the connection (react-query pauses the mutation);
    // once back online the typed price is what is sent.
    onlineManager.setOnline(true);
    expect((await book()).priceCents).toBe(5800);
  });

  it("a background refetch greys Book until it returns, and the same price turns Book back on", async () => {
    await render({ open: true, clientId: CLIENT_A });
    await answer(last(), { cents: 5000 });
    expect(bookButton().disabled).toBe(false);
    await act(async () => {
      void qc.invalidateQueries({ queryKey: ["one-off-set-price"] });
    });
    await flush();
    expect(bookButton().disabled).toBe(true);
    await answer(last(), { cents: 5000 });
    expect(priceBox()!.value).toBe("50.00");
    expect(bookButton().disabled).toBe(false);
    expect((await book()).priceCents).toBe(5000);
  });

  it("a background refetch that returns a new price shows it", async () => {
    await render({ open: true, clientId: CLIENT_A });
    await answer(last(), { cents: 5000 });
    await act(async () => {
      void qc.invalidateQueries({ queryKey: ["one-off-set-price"] });
    });
    await flush();
    await answer(last(), { cents: 6000 });
    expect(priceBox()!.value).toBe("60.00");
    expect(bookButton().disabled).toBe(false);
  });

  it("someone who cannot set prices is not blocked by a refetch or a failure", async () => {
    h.perms = new Set(["booking"]);
    await render({ open: true, clientId: CLIENT_A });
    await answer(last(), { cents: 5000 });
    expect(priceBox()!.value).toBe("50.00");
    expect(bookButton().disabled).toBe(false);
    record();
    await act(async () => {
      void qc.invalidateQueries({ queryKey: ["one-off-set-price"] });
    });
    await flush();
    expect(bookButton().disabled).toBe(false);
    await fail(last());
    expect(bookButton().disabled).toBe(false);
    expect(h.bookRenders.every((d) => !d)).toBe(true);
    expect((await book()).priceCents).toBe(5000);
  });

  it("someone who sets prices but cannot change settings has no lookup and is never held up", async () => {
    h.perms = new Set(["manage_pricing"]);
    await render({ open: true, clientId: CLIENT_A });
    expect(calls).toHaveLength(0);
    await typePrice("45.00");
    expect(bookButton().disabled).toBe(false);
    expect((await book()).priceCents).toBe(4500);
  });
});
