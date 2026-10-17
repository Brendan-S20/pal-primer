import { beforeEach, describe, expect, it, vi } from "vitest";

// The portal's grooming server functions and the office's "Book this groom"
// link, against a fake database that records every query. Nothing here
// reaches a real Supabase project.

type Q = {
  table: string;
  op: string;
  cols?: string;
  filters: Array<[string, ...unknown[]]>;
  payload?: unknown;
};
type Resp = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  queries: [] as Q[],
  handler: (() => undefined) as (q: Q) => Resp | undefined,
  rpc: vi.fn(),
  session: { clientId: "client-1", organizationId: "org-1", preview: false },
  notify: vi.fn(async () => ({ inserted: ["n"], coalesced: [], pushed: [] })),
  officeEmail: vi.fn(async () => {}),
  permission: vi.fn(async () => ({ orgId: "org-1", role: "owner" })),
}));

function makeDb() {
  return {
    from(table: string) {
      const q: Q = { table, op: "select", filters: [] };
      state.queries.push(q);
      const chain: Record<string, unknown> = {};
      const filter =
        (name: string) =>
        (...args: unknown[]) => {
          q.filters.push([name, ...args]);
          return chain;
        };
      for (const f of ["eq", "neq", "in", "is", "gt", "lte", "order", "limit", "not"])
        chain[f] = filter(f);
      chain.select = (cols?: string) => {
        if (q.op === "select") q.cols = cols;
        return chain;
      };
      for (const op of ["insert", "update", "upsert"])
        chain[op] = (payload: unknown) => {
          q.op = op;
          q.payload = payload;
          return chain;
        };
      const settle = () => Promise.resolve(state.handler(q) ?? { data: null, error: null });
      chain.single = settle;
      chain.maybeSingle = settle;
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        settle().then(res, rej);
      return chain;
    },
    rpc: (...args: unknown[]) => state.rpc(...args),
  };
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({
            data: validate(args?.data),
            context: { supabase: makeDb(), userId: "office-user" },
          }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return makeDb();
  },
}));
vi.mock("@/lib/portal-auth.server", () => ({
  requirePortalSession: vi.fn(async (_t: string, opts: { readOnly?: boolean } = {}) => {
    if (state.session.preview && !opts.readOnly) throw new Error("preview is read-only");
    return state.session;
  }),
}));
vi.mock("@/lib/notify-center.server", () => ({ notifyRoles: state.notify }));
vi.mock("@/lib/portal.functions", () => ({ notifyOfficeOfConcern: state.officeEmail }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: state.permission,
  resolveCaller: state.permission,
}));
// The request path is closed today (customerCanRequestService refuses
// mobile_grooming). The tests below that exercise the path open the gate
// here, so the path is still checked for the day it opens; the gate itself
// is tested with the real answer.
const gate = vi.hoisted(() => ({ open: false }));
vi.mock("@/lib/service-lines", async (orig) => {
  const real = await orig<typeof import("@/lib/service-lines")>();
  return {
    ...real,
    customerCanRequestService: (line: string) =>
      line === "mobile_grooming" && gate.open ? true : real.customerCanRequestService(line),
  };
});

import { portalGetGrooming, portalRequestGroom } from "@/lib/portal-groom.functions";
import { linkGroomBooking } from "@/lib/concerns.functions";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const DOG = "22222222-2222-4222-8222-222222222222";
const SVC = "33333333-3333-4333-8333-333333333333";
const TEETH = "44444444-4444-4444-8444-444444444444";
const TICKET = "55555555-5555-4555-8555-555555555555";
const VISIT = "66666666-6666-4666-8666-666666666666";

let lines: string[];
function groomingOrg(q: Q): Resp | undefined {
  if (q.table === "organizations")
    return {
      data: {
        service_lines: lines,
        timezone: "America/Chicago",
        groom_buffer_min: 20,
        work_days: [1, 2, 3, 4, 5],
      },
      error: null,
    };
  if (q.table === "properties")
    return { data: [{ id: "prop-1", street: "1 Main", city: "Austin" }], error: null };
  if (q.table === "dogs")
    return {
      data: [
        {
          id: DOG,
          name: "Biscuit",
          breed: "Collie",
          weight_class: "large",
          weight_lb: null,
          coat_type: "double",
          property_id: "prop-1",
        },
      ],
      error: null,
    };
  if (q.table === "services")
    return {
      data: [
        {
          id: SVC,
          name: "Full groom",
          price_unit: "visit",
          base_price_cents: 8000,
          extra_pet_cents: 0,
          default_duration_min: 90,
        },
      ],
      error: null,
    };
  if (q.table === "service_size_rules")
    return {
      data: [
        {
          service_id: SVC,
          size: "large",
          coat_type: "double",
          duration_min: 150,
          price_cents: 13000,
        },
      ],
      error: null,
    };
  if (q.table === "addon_services")
    return {
      data: [
        {
          id: TEETH,
          name: "Teeth brushing",
          description: null,
          unit_price_cents: 1500,
          duration_min: 10,
          service_line: "mobile_grooming",
        },
        {
          id: "yard",
          name: "Deodorizer",
          description: null,
          unit_price_cents: 900,
          duration_min: 5,
          service_line: "pet_waste",
        },
      ],
      error: null,
    };
  if (q.table === "qc_tickets" && q.op === "select") return { data: [], error: null };
  if (q.table === "clients") return { data: { display_name: "Pat Client" }, error: null };
  return undefined;
}

const ask = (over: Record<string, unknown> = {}) =>
  portalRequestGroom({
    data: {
      token: TOKEN,
      dogId: DOG,
      serviceId: SVC,
      addons: [{ addonServiceId: TEETH, quantity: 1 }],
      day: "2026-11-03",
      window: "morning",
      message: "Short cut",
      ...over,
    },
  });

beforeEach(() => {
  state.queries = [];
  state.rpc.mockReset();
  state.notify.mockClear();
  state.officeEmail.mockClear();
  state.session = { clientId: "client-1", organizationId: "org-1", preview: false };
  lines = ["pet_waste", "mobile_grooming"];
  gate.open = true;
  state.handler = groomingOrg;
  state.rpc.mockResolvedValue({ data: [{ ticket_id: TICKET, created: true }], error: null });
});

describe("the portal Grooming page", () => {
  it("is not there for a client whose business does not groom", async () => {
    lines = ["pet_waste"];
    expect(await portalGetGrooming({ data: { token: TOKEN } })).toEqual({ visible: false });
    expect(state.queries.map((q) => q.table)).toEqual(["organizations"]);
  });

  it("lists only this client's pets and only grooming add-ons", async () => {
    const page = await portalGetGrooming({ data: { token: TOKEN } });
    if (!page.visible) throw new Error("expected the page");
    expect(page.pets.map((p) => [p.name, p.size, p.coat_type])).toEqual([
      ["Biscuit", "large", "double"],
    ]);
    expect(page.addons.map((a) => a.id)).toEqual([TEETH]);
    const props = state.queries.find((q) => q.table === "properties")!;
    expect(props.filters).toContainEqual(["eq", "client_id", "client-1"]);
    const dogs = state.queries.find((q) => q.table === "dogs")!;
    expect(dogs.filters).toContainEqual(["in", "property_id", ["prop-1"]]);
  });
});

describe("groom requests are off while grooming is not customer-requestable", () => {
  beforeEach(() => {
    gate.open = false;
  });

  it("the page says so, for a business that runs grooming", async () => {
    const page = await portalGetGrooming({ data: { token: TOKEN } });
    if (!page.visible) throw new Error("expected the page");
    expect(page.canRequest).toBe(false);
  });

  it("refuses the request before the database is asked, and tells nobody", async () => {
    await expect(ask()).rejects.toThrow("Grooms are booked by the office.");
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.officeEmail).not.toHaveBeenCalled();
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("the page draws the request form only when asking is on", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(
      new URL("../src/routes/portal.$slug.$token.grooming.tsx", import.meta.url),
      "utf8",
    );
    expect(page).toMatch(/\{page\.canRequest && <RequestGroomCard page=\{page\} \/>\}/);
    expect(page.match(/<RequestGroomCard /g)).toHaveLength(1);
    for (const file of ["index", "property"]) {
      const src = readFileSync(
        new URL(`../src/routes/portal.$slug.$token.${file}.tsx`, import.meta.url),
        "utf8",
      );
      const offers = src.split(/groom requests|Request a groom/i).length - 1;
      expect(offers, file).toBe(src.split("c?.groom_requests").length - 1);
    }
  });

  it("the database refuses it too, whatever the business runs", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(
      new URL("../supabase/migrations/20261016230000_grooming-portal.sql", import.meta.url),
      "utf8",
    );
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.portal_request_groom"));
    expect(fn).toContain("_customer_requestable CONSTANT boolean := false;");
    expect(fn).toMatch(/IF NOT _customer_requestable THEN\s+RAISE EXCEPTION 'groom_requests_off';/);
    // Before any row is read or written.
    expect(fn.indexOf("'groom_requests_off'")).toBeLessThan(fn.indexOf("FROM public.dogs"));
  });
});

describe("a client asks for a groom (with the gate opened)", () => {
  it("prices it with the office's rules and sends it to the office queue", async () => {
    const r = await ask();
    expect(r).toEqual({ ticketId: TICKET, alreadyAsked: false, cents: 14500, minutes: 180 });
    expect(state.rpc).toHaveBeenCalledWith("portal_request_groom", {
      _token: TOKEN,
      _dog_id: DOG,
      _service_id: SVC,
      _addons: [{ addon_service_id: TEETH, quantity: 1 }],
      _on: "2026-11-03",
      _from: "08:00",
      _until: "12:00",
      _message: "Short cut",
      _quoted_cents: 14500,
      _quoted_minutes: 180,
    });
    expect(state.officeEmail).toHaveBeenCalledTimes(1);
    expect(state.notify).toHaveBeenCalledWith(
      ["owner", "office_manager"],
      expect.objectContaining({ link: "/concerns", eventKey: `groom-request:${TICKET}` }),
    );
  });

  it("never books a visit or a plan", async () => {
    await ask();
    const tables = state.queries.map((q) => q.table);
    expect(tables).not.toContain("visits");
    expect(tables).not.toContain("subscriptions");
    expect(state.queries.filter((q) => q.op !== "select")).toEqual([]);
  });

  it("tells nobody twice when the request was already sent", async () => {
    state.rpc.mockResolvedValue({ data: [{ ticket_id: TICKET, created: false }], error: null });
    expect((await ask()).alreadyAsked).toBe(true);
    expect(state.officeEmail).not.toHaveBeenCalled();
    expect(state.notify).not.toHaveBeenCalled();
  });

  it("asks for any time with no window", async () => {
    await ask({ window: "any" });
    expect(state.rpc.mock.calls[0][1]).toMatchObject({ _from: null, _until: null });
  });

  it("refuses a business that does not groom, before the database is asked", async () => {
    lines = ["pet_waste"];
    await expect(ask()).rejects.toThrow("Grooming isn't offered by this business.");
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a pet that is not this client's", async () => {
    await expect(ask({ dogId: "77777777-7777-4777-8777-777777777777" })).rejects.toThrow(
      "Choose one of your pets.",
    );
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a service that is not one of the business's grooms", async () => {
    await expect(ask({ serviceId: "88888888-8888-4888-8888-888888888888" })).rejects.toThrow(
      /groom isn't offered/,
    );
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses an add-on that is not a grooming add-on", async () => {
    await expect(
      ask({ addons: [{ addonServiceId: "99999999-9999-4999-8999-999999999999", quantity: 1 }] }),
    ).rejects.toThrow(/add-ons isn't offered/);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("words the database's refusal", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "not_a_working_day" } });
    await expect(ask()).rejects.toThrow("We don't groom that day. Please pick another.");
  });

  it("refuses a window it does not know and an add-on listed twice", async () => {
    await expect(ask({ window: "midnight" })).rejects.toThrow();
    await expect(
      ask({
        addons: [
          { addonServiceId: TEETH, quantity: 1 },
          { addonServiceId: TEETH, quantity: 2 },
        ],
      }),
    ).rejects.toThrow(/listed twice/);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a staff preview", async () => {
    state.session = { ...state.session, preview: true };
    await expect(ask()).rejects.toThrow(/read-only/);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("every grooming portal handler checks the session", () => {
  it("opens a session first, and only the read is allowed in a staff preview", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../src/lib/portal-groom.functions.ts", import.meta.url),
      "utf8",
    );
    const handlers = source.split(/export const /).slice(1);
    expect(handlers.length).toBe(2);
    for (const h of handlers) {
      expect(h).toMatch(/requirePortalSession\(data\.token/);
      expect(h.includes("readOnly: true")).toBe(h.includes('method: "GET"'));
    }
  });
});

describe("the office books a groom request", () => {
  let ticket: Record<string, unknown>;
  let visit: Record<string, unknown>;
  beforeEach(() => {
    ticket = {
      id: TICKET,
      category: "groom_request",
      client_id: "client-1",
      property_id: "prop-1",
      booked_visit_id: null,
    };
    visit = {
      id: VISIT,
      client_id: "client-1",
      property_id: "prop-1",
      organization_id: "org-1",
      scheduled_on: "2026-11-03",
      start_time: "09:30:00",
    };
    state.handler = (q) => {
      if (q.table === "qc_tickets" && q.op === "select") return { data: ticket, error: null };
      if (q.table === "qc_tickets" && q.op === "update")
        return { data: [{ id: TICKET }], error: null };
      if (q.table === "visits") return { data: visit, error: null };
      return undefined;
    };
  });
  const link = () => linkGroomBooking({ data: { ticketId: TICKET, visitId: VISIT } });

  it("links the booked groom and resolves the request with its day and time", async () => {
    await link();
    const update = state.queries.find((q) => q.table === "qc_tickets" && q.op === "update")!;
    expect(update.payload).toMatchObject({
      booked_visit_id: VISIT,
      status: "resolved",
      resolution_note: expect.stringMatching(/^Booked for .+ at 09:30\.$/),
    });
    expect(state.permission).toHaveBeenCalledWith(
      expect.anything(),
      "office-user",
      "manage_pricing",
    );
  });

  it("refuses a request that is not a groom request", async () => {
    ticket.category = "one_off_request";
    await expect(link()).rejects.toThrow("Only a groom request");
  });

  it("refuses a visit for another client or address", async () => {
    visit.client_id = "client-2";
    await expect(link()).rejects.toThrow("different client");
    visit.client_id = "client-1";
    visit.property_id = "prop-2";
    await expect(link()).rejects.toThrow("different address");
  });

  it("refuses a second groom for a request already booked", async () => {
    ticket.booked_visit_id = "another-visit";
    await expect(link()).rejects.toThrow("already has a groom");
  });
});
