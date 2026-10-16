// The portal shows the walk and never the code (#410).
//
// A dog-walking client sees each finished walk's report (walker, times,
// duration, pee and poo, the walker's note, the photos) and each upcoming
// walk's window. They can tell the business how to get in: the way in, where
// the key is, and two codes that are WRITE-ONLY. The portal is told "On
// file" or "Not set" and nothing else, the write is scoped to the client's
// own walk properties, and the office's activity line never carries a code.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown }) => unknown) =>
        async (opts: { data?: unknown } = {}) =>
          h({ data: validate(opts.data) }),
    };
    return b;
  },
}));

const state = vi.hoisted(() => ({
  session: { clientId: "client-a", organizationId: "org-1", preview: false },
  subscriptions: [] as any[],
  properties: [] as any[],
  updates: [] as Array<{ table: string; patch: any }>,
  activity: [] as any[],
}));

vi.mock("@/lib/portal-auth.server", () => ({
  requirePortalSession: async (_t: string, opts: { readOnly?: boolean } = {}) => {
    if (state.session.preview && !opts.readOnly) throw new Error("preview is read-only");
    return state.session;
  },
}));

vi.mock("@/lib/activity.server", () => ({
  logActivity: async (_sb: unknown, entry: unknown) => {
    state.activity.push(entry);
  },
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    let patch: any = null;
    const source = () => (table === "subscriptions" ? state.subscriptions : state.properties);
    const rows = () => source().filter((r: any) => filters.every((f) => f(r)));
    const q: any = {
      select: () => q,
      order: () => q,
      update: (p: any) => ((patch = p), q),
      eq: (col: string, v: unknown) => {
        // services.service_line is an embedded filter on the plan's service.
        if (col === "services.service_line") filters.push((r) => r.services?.service_line === v);
        else filters.push((r) => r[col] === v);
        return q;
      },
      in: (col: string, vs: unknown[]) =>
        (filters.push((r) => vs.includes(col === "services.service_line" ? r.services?.service_line : r[col])), q),
      is: (col: string, v: unknown) => (filters.push((r) => (r[col] ?? null) === v), q),
      then: (res: (v: unknown) => unknown) => {
        if (patch) {
          const hit = rows();
          for (const r of hit) Object.assign(r, patch);
          state.updates.push({ table, patch });
          return Promise.resolve({ data: hit, error: null }).then(res);
        }
        return Promise.resolve({ data: rows(), error: null }).then(res);
      },
    };
    return q;
  };
  return { supabaseAdmin: { from } };
});

const { portalGetAccess, portalUpdateAccess, portalAccessOf, accessPatch, portalUpdateAccessSchema } =
  await import("@/lib/portal-access.functions");

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const TOKEN = "11111111-1111-4111-8111-111111111111";
const P_OWN = "22222222-2222-4222-8222-222222222222";
const P_OTHER = "33333333-3333-4333-8333-333333333333";
const SECRET_BOX = "4471";
const SECRET_DOOR = "9020#";

beforeEach(() => {
  state.session = { clientId: "client-a", organizationId: "org-1", preview: false };
  state.subscriptions = [
    {
      property_id: P_OWN,
      client_id: "client-a",
      organization_id: "org-1",
      status: "active",
      services: { service_line: "dog_walking" },
    },
    {
      property_id: P_OTHER,
      client_id: "client-b",
      organization_id: "org-1",
      status: "active",
      services: { service_line: "dog_walking" },
    },
  ];
  state.properties = [
    {
      id: P_OWN,
      client_id: "client-a",
      organization_id: "org-1",
      archived_at: null,
      label: null,
      street: "1 Leash Ln",
      access_method: "lockbox",
      key_location: null,
      lock_box_code: SECRET_BOX,
      gate_code: SECRET_DOOR,
      key_tag: "TAG-7",
    },
    {
      id: P_OTHER,
      client_id: "client-b",
      organization_id: "org-1",
      archived_at: null,
      label: null,
      street: "2 Leash Ln",
      access_method: null,
      key_location: null,
      lock_box_code: "1111",
      gate_code: null,
      key_tag: null,
    },
  ];
  state.updates = [];
  state.activity = [];
});

describe("what the portal is told", () => {
  it("On file or Not set, never a code", async () => {
    const out = await portalGetAccess({ data: { token: TOKEN } });
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET_BOX);
    expect(text).not.toContain(SECRET_DOOR);
    expect(text).not.toContain("TAG-7");
    expect(text).not.toContain("1111");
    expect(out.properties).toEqual([
      {
        propertyId: P_OWN,
        label: null,
        street: "1 Leash Ln",
        accessMethod: "lockbox",
        keyLocation: null,
        lockBoxSet: true,
        doorCodeSet: true,
      },
    ]);
  });

  it("nothing for a client with no walk plan, so a scooping client's tab is unchanged", async () => {
    state.subscriptions = state.subscriptions.map((s) => ({ ...s, services: { service_line: "pet_waste" } }));
    await expect(portalGetAccess({ data: { token: TOKEN } })).resolves.toEqual({ properties: [] });
  });

  it("a sitting client can update access with the same write-only code response", async () => {
    state.subscriptions[0].services.service_line = "pet_sitting";
    const out = await portalUpdateAccess({ data: { token: TOKEN, propertyId: P_OWN, doorCode: "5566" } });
    expect(out.access.doorCodeSet).toBe(true);
    expect(JSON.stringify(out)).not.toContain("5566");
    expect(JSON.stringify(state.activity)).not.toContain("5566");
  });

  it("portalAccessOf is the only shape, and it has no field for a code", () => {
    const shape = portalAccessOf(state.properties[0]);
    expect(Object.keys(shape).sort()).toEqual(
      ["accessMethod", "doorCodeSet", "keyLocation", "label", "lockBoxSet", "propertyId", "street"].sort(),
    );
  });
});

describe("a client updates how we get in", () => {
  it("replaces a code, and the reply and the activity line still carry no code", async () => {
    const out = await portalUpdateAccess({
      data: { token: TOKEN, propertyId: P_OWN, lockBoxCode: "5555", accessMethod: "lockbox" },
    });
    expect(state.properties[0].lock_box_code).toBe("5555");
    expect(JSON.stringify(out)).not.toContain("5555");
    expect(out.access.lockBoxSet).toBe(true);
    expect(state.activity).toHaveLength(1);
    expect(JSON.stringify(state.activity)).not.toContain("5555");
    expect(state.activity[0]).toMatchObject({
      orgId: "org-1",
      clientId: "client-a",
      propertyId: P_OWN,
      kind: "property.access_updated",
    });
  });

  it("removes a code with null, and leaves the other alone", async () => {
    await portalUpdateAccess({ data: { token: TOKEN, propertyId: P_OWN, doorCode: null } });
    expect(state.properties[0].gate_code).toBeNull();
    expect(state.properties[0].lock_box_code).toBe(SECRET_BOX);
  });

  it("refuses another client's property and writes nothing", async () => {
    await expect(
      portalUpdateAccess({ data: { token: TOKEN, propertyId: P_OTHER, lockBoxCode: "0000" } }),
    ).rejects.toThrow("That address isn't on your account.");
    expect(state.updates).toEqual([]);
    expect(state.properties[1].lock_box_code).toBe("1111");
  });

  it("refuses a staff preview", async () => {
    state.session = { ...state.session, preview: true };
    await expect(
      portalUpdateAccess({ data: { token: TOKEN, propertyId: P_OWN, lockBoxCode: "0000" } }),
    ).rejects.toThrow(/read-only/);
    expect(state.updates).toEqual([]);
  });

  it("refuses an empty code, a long one, and a way in the database does not know", () => {
    const base = { token: TOKEN, propertyId: P_OWN };
    expect(() => portalUpdateAccessSchema.parse({ ...base, lockBoxCode: "  " })).toThrow();
    expect(() => portalUpdateAccessSchema.parse({ ...base, lockBoxCode: "x".repeat(41) })).toThrow();
    expect(() => portalUpdateAccessSchema.parse({ ...base, accessMethod: "window" })).toThrow();
  });

  it("only writes what was sent", () => {
    expect(accessPatch({ token: TOKEN, propertyId: P_OWN })).toEqual({ patch: {}, changed: [] });
    const { patch, changed } = accessPatch({
      token: TOKEN,
      propertyId: P_OWN,
      lockBoxCode: "1234",
      keyLocation: "",
    });
    expect(patch).toEqual({ lock_box_code: "1234", key_location: null });
    expect(changed.join(" ")).not.toContain("1234");
  });
});

describe("the walk reports", () => {
  const src = read("src/lib/portal-walks.functions.ts");
  const selects = [...src.matchAll(/\.select\(\s*"([^"]+)"/g)].map((m) => m[1]).join(" | ");

  it("never reads an office note or a way into the home", () => {
    for (const col of ["tech_note", "gate_code", "lock_box_code", "key_tag", "access_notes", "key_location"]) {
      expect(selects, col).not.toContain(col);
    }
  });

  it("reads only this client's completed walks, as a read a preview may make", () => {
    expect(src).toMatch(/requirePortalSession\(data\.token, \{ readOnly: true \}\)/);
    expect(src).toMatch(/\.eq\("client_id", session\.clientId\)/);
    expect(src).toMatch(/\.eq\("organization_id", session\.organizationId\)/);
    expect(src).toMatch(/\.eq\("status", "completed"\)/);
    expect(src).toMatch(/\.eq\("services\.service_line", "dog_walking"\)/);
    expect(src).toMatch(/if \(!serviceLinesOrDefault\(org\?\.service_lines\)\.includes\("dog_walking"\)\) return empty;/);
  });

  it("says each line through walk-report.ts, the same rules as the email", () => {
    expect(src).toMatch(/walkReportEmail\(\{/);
  });

  it("the visits tab draws the reports and each upcoming walk's window", () => {
    const route = read("src/routes/portal.$slug.$token.visits.tsx");
    expect(route).toMatch(/<WalkReportsSection reports=\{walks\.reports\} \/>/);
    expect(route).toMatch(/walk_window: walks\.upcomingWindows\[v\.visit_id\]/);
    const ui = read("src/lib/portal-ui.tsx");
    expect(ui).toMatch(/!v\.eta_start && v\.walk_window/);
  });

  it("the property tab draws How we get in, which never renders a code", () => {
    expect(read("src/routes/portal.$slug.$token.property.tsx")).toMatch(/<WalkAccessCard \/>/);
    const card = read("src/components/portal/WalkAccessCard.tsx");
    expect(card).toMatch(/isSet \? "On file" : "Not set"/);
    expect(card).toMatch(/type="password"/);
    expect(card).not.toMatch(/lock_box_code|gate_code/);
  });
});
