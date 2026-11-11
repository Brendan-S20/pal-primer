// A walk over its dog cap is warned, then allowed (#731).
//
// Brendan, 2026-11-10 2:24 PM ET: "Warn but allow going over the dog cap".
// Acceptance, item by item:
//   * assigning one dog over the cap shows the warning;
//   * confirming saves the assignment with the flag;
//   * cancelling changes nothing;
//   * bulk assignment and Cover show the same warning (and so do drag on the
//     board, the visit drawer and the Group walks panel).
// The database half (refused unless confirmed, recorded when confirmed) is
// supabase/proofs/20261111130000-... and
// tests/integration/a-walk-over-its-dog-cap-is-warned-then-allowed.db.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const context: { supabase: unknown; userId: string } = { supabase: null, userId: "office-user" };
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: (data: unknown) => unknown) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args: { data: unknown }) =>
          fn({ data: validate(args.data), context }),
    };
    return builder;
  },
  useServerFn: (f: unknown) => f,
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org-a", role: "dispatcher" }),
  requirePermission: async () => ({ orgId: "org-a", role: "owner" }),
}));

import {
  DOG_CAP_HEADER,
  dogCapSentence,
  dogCapWarningFromError,
  isDogCapRefused,
  overCapByVisit,
  runWithDogCapWarning,
  withDogCapAck,
  type DogCapWarning,
} from "@/lib/dog-cap";
import { DogCapWarningDescription } from "@/components/DogCapWarning";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** What PostgREST hands back for walk_dog_cap_guard's refusal. */
const capError = (dogs = 7, cap = 6) => ({
  code: "23514",
  message: `This walk will have ${dogs} dogs; the cap is ${cap}.`,
  hint: "dog_cap",
  details: JSON.stringify({
    walk_group_id: "g1",
    staff_id: "s1",
    walker: "Ann",
    dogs,
    cap,
  }),
});

describe("the warning says what the owner said", () => {
  it("in the owner's own words: 'This walk will have 7 dogs; the cap is 6.'", () => {
    expect(dogCapSentence({ dogs: 7, cap: 6 })).toBe("This walk will have 7 dogs; the cap is 6.");
  });

  it("reads the database's refusal back into the numbers and the walker", () => {
    expect(dogCapWarningFromError(capError())).toEqual({
      dogs: 7,
      cap: 6,
      walker: "Ann",
      walkGroupId: "g1",
      staffId: "s1",
    });
    // Without the JSON detail, the sentence itself still carries the numbers.
    expect(
      dogCapWarningFromError({ hint: "dog_cap", details: null, message: capError(5, 3).message }),
    ).toMatchObject({ dogs: 5, cap: 3, walker: null });
  });

  it("is not confused with the time-off guard, which shares its SQLSTATE", () => {
    expect(
      dogCapWarningFromError({
        code: "23514",
        message: "Ann is off that day",
        hint: null,
      } as never),
    ).toBeNull();
    expect(dogCapWarningFromError(null)).toBeNull();
  });

  it("draws the sentence, the walker's cap and how far over in the dialog", () => {
    const warning = dogCapWarningFromError(capError())!;
    const html = renderToStaticMarkup(createElement(DogCapWarningDescription, { warning }));
    expect(html).toContain("This walk will have 7 dogs; the cap is 6.");
    expect(html).toContain("walks up to 6 dogs at a time");
    expect(html).toContain("recorded as over the cap by");
    expect(html).toContain("flagged on the board and in My Day");
  });
});

describe("warn, then allow (one flow for every assign control)", () => {
  const warning: DogCapWarning = dogCapWarningFromError(capError())!;

  it("one dog over the cap shows the warning before anything is saved", async () => {
    const attempt = vi.fn(async (ack: boolean) => (ack ? { ok: true } : { overCap: warning }));
    const ask = vi.fn(async () => false);
    await runWithDogCapWarning(attempt, ask);
    expect(ask).toHaveBeenCalledWith(warning, undefined);
    expect(attempt.mock.calls[0]).toEqual([false]);
  });

  it("confirming sends the same write again, confirmed, and returns what it saved", async () => {
    const attempt = vi.fn(async (ack: boolean) =>
      ack ? { ok: true as const } : { overCap: warning },
    );
    const result = await runWithDogCapWarning(attempt, async () => true);
    expect(attempt.mock.calls).toEqual([[false], [true]]);
    expect(result).toEqual({ ok: true });
  });

  it("cancelling changes nothing: no second send, and null to the caller", async () => {
    const attempt = vi.fn(async () => ({ overCap: warning }));
    const result = await runWithDogCapWarning(attempt, async () => false);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it("under the cap, nothing is asked", async () => {
    const ask = vi.fn(async () => true);
    const result = await runWithDogCapWarning(async () => ({ ok: true }), ask);
    expect(ask).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("Cover passes how many visits fit nobody's cap", async () => {
    const ask = vi.fn(async () => false);
    await runWithDogCapWarning(async () => ({ overCap: warning, overCapVisits: 3 }), ask);
    expect(ask).toHaveBeenCalledWith(warning, 3);
  });
});

describe("the confirmation reaches the database only when the person confirmed", () => {
  const builder = () => {
    const headers: Record<string, string> = {};
    const b = {
      headers,
      setHeader(name: string, value: string) {
        headers[name] = value;
        return b;
      },
    };
    return b;
  };

  it("sets x-dog-cap-acknowledged: yes on 'Assign anyway', and nothing otherwise", () => {
    expect(withDogCapAck(builder(), true).headers).toEqual({ [DOG_CAP_HEADER]: "yes" });
    expect(withDogCapAck(builder(), false).headers).toEqual({});
    expect(withDogCapAck(builder(), undefined).headers).toEqual({});
  });
});

/** A signed-in client whose write is refused for the cap unless the
 *  confirmation header is on it, the way walk_dog_cap_guard decides. */
function fakeClient() {
  const writes: Array<{ table: string; acknowledged: boolean; patch: unknown }> = [];
  return {
    writes,
    rpc: async (fn: string) => ({ data: fn === "can_write_org" ? true : null, error: null }),
    from(table: string) {
      let patch: unknown;
      let acknowledged = false;
      type Query = {
        update: (p: unknown) => Query;
        eq: () => Query;
        select: () => Query;
        setHeader: (name: string, value: string) => Query;
        then: (resolve: (v: unknown) => unknown) => Promise<unknown>;
      };
      const q: Query = {
        update: (p: unknown) => ((patch = p), q),
        eq: () => q,
        select: () => q,
        setHeader: (name: string, value: string) => {
          if (name === DOG_CAP_HEADER && value === "yes") acknowledged = true;
          return q;
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (!acknowledged)
            return Promise.resolve({ data: null, error: capError(4, 3) }).then(resolve);
          writes.push({ table, acknowledged, patch });
          return Promise.resolve({ data: [{ id: "row" }], error: null }).then(resolve);
        },
      };
      return q;
    },
  };
}

describe("the Group walks panel's writes (server)", () => {
  const VISIT = "11111111-1111-4111-8111-111111111111";
  const GROUP = "22222222-2222-4222-8222-222222222222";
  const WALKER = "33333333-3333-4333-8333-333333333333";
  let db: ReturnType<typeof fakeClient>;
  beforeEach(() => {
    db = fakeClient();
    context.supabase = db;
  });

  it("adding one dog over the cap answers the warning and saves nothing", async () => {
    const { setWalkGroupMember } = await import("@/lib/walk-groups.functions");
    const r = await setWalkGroupMember({ data: { visitId: VISIT, groupId: GROUP } });
    expect(isDogCapRefused(r)).toBe(true);
    expect((r as { overCap: DogCapWarning }).overCap).toMatchObject({ dogs: 4, cap: 3 });
    expect(db.writes).toEqual([]);
  });

  it("confirmed, the same write is sent with the confirmation and saved", async () => {
    const { setWalkGroupMember } = await import("@/lib/walk-groups.functions");
    const r = await setWalkGroupMember({
      data: { visitId: VISIT, groupId: GROUP, overCapAcknowledged: true },
    });
    expect(r).toEqual({ ok: true });
    expect(db.writes).toEqual([
      { table: "visits", acknowledged: true, patch: { walk_group_id: GROUP, sequence: null } },
    ]);
  });

  it("giving a group to a walker it puts over the cap is warned the same way", async () => {
    const { setWalkGroupWalker } = await import("@/lib/walk-groups.functions");
    const refused = await setWalkGroupWalker({ data: { groupId: GROUP, walkerId: WALKER } });
    expect(isDogCapRefused(refused)).toBe(true);
    const saved = await setWalkGroupWalker({
      data: { groupId: GROUP, walkerId: WALKER, overCapAcknowledged: true },
    });
    expect(saved).toEqual({ ok: true });
    expect(db.writes).toHaveLength(1);
  });
});

describe("nothing goes over the cap silently: every assign control shows the same warning", () => {
  const routes = read("src/routes/_authenticated/routes.tsx");
  const between = (from: string, to: string) =>
    routes.slice(routes.indexOf(from), routes.indexOf(to, routes.indexOf(from)));

  it("drag on the board", () => {
    const drag = between("async function onDragEnd(", "const activeVisit =");
    expect(drag).toMatch(/dogCap\.run\(\(overCapAcknowledged\) =>\s*reassign\(/);
    expect(drag).toContain("overCapAcknowledged,");
    // Cancelled: the card goes back.
    expect(drag).toMatch(
      /if \(r === null \|\| isDogCapRefused\(r\)\) \{[\s\S]*?setLocalColumns\(null\)/,
    );
  });

  it("bulk assignment", () => {
    const bulk = between("const bulkAssignMut = useMutation({", "const bulkRescheduleMut");
    expect(bulk).toMatch(/dogCap\.run\(\(overCapAcknowledged\) =>\s*bulkAssignFn\(/);
    expect(bulk).toContain('toast("Nothing was assigned.")');
  });

  it("Cover", () => {
    const cover = between("const redistributeMut = useMutation({", "/** Who runs routes");
    expect(cover).toContain("overCapAcknowledged,");
    expect(cover).toMatch(/if \(await dogCap\.ask\(first\.overCap, first\.overCapVisits\)\)/);
    expect(cover).toContain("await send(true)");
  });

  it("the board shows the dialog and flags an over-cap walk on its cards", () => {
    expect(routes).toContain("{dogCap.dialog}");
    expect(routes).toContain("<OverCapContext.Provider value={overCap}>");
    expect(routes).toContain("useContext(OverCapContext).get(visit.id)");
    expect(routes).toContain('data-testid="over-dog-cap"');
    expect(routes).toContain("listOverCap({ data: { day } })");
  });

  it("the visit drawer and the Group walks panel", () => {
    const drawer = read("src/components/VisitDetailDrawer.tsx");
    expect(drawer).toMatch(/dogCap\s*\.run\(\(overCapAcknowledged\) =>\s*doReassign\(/);
    expect(drawer).toContain("{dogCap.dialog}");
    const panel = read("src/components/routes/GroupWalksPanel.tsx");
    expect(panel.match(/dogCap\.run\(\(overCapAcknowledged\) =>/g)).toHaveLength(2);
    expect(panel).toContain("{dogCap.dialog}");
  });

  it("every server write takes the confirmation and turns the refusal into the warning", () => {
    const visits = read("src/lib/visits.functions.ts");
    for (const fn of ["reassignVisit", "bulkAssignVisits", "redistributeStaffWork"]) {
      const start = visits.indexOf(`export const ${fn} = createServerFn`);
      const body = visits.slice(start, visits.indexOf("\nexport const ", start + 10));
      expect(body, fn).toContain("overCapAcknowledged: z.boolean().optional()");
      expect(body, fn).toContain("withDogCapAck(");
      expect(body, fn).toContain("dogCapWarningFromError(");
    }
    const groups = read("src/lib/walk-groups.functions.ts");
    for (const fn of ["setWalkGroupMember", "setWalkGroupWalker"]) {
      const start = groups.indexOf(`export const ${fn} = createServerFn`);
      const body = groups.slice(start, groups.indexOf("\nexport const ", start + 10));
      expect(body, fn).toContain("withDogCapAck(");
      expect(body, fn).toContain("if (overCap) return { overCap };");
    }
  });
});

describe("an over-cap walk stays flagged until it is back under", () => {
  it("flags each visit on a listed walk, and none once the walk is no longer listed", () => {
    const walk = { walkGroupId: "g1", staffId: "s1", visitIds: ["v1", "v2"], dogs: 7, cap: 6 };
    expect(overCapByVisit([walk]).get("v2")).toEqual(walk);
    expect(overCapByVisit([]).size).toBe(0);
  });

  it("My Day draws it through t(), in every language", () => {
    for (const lng of ["en", "es", "ar", "zh"]) {
      expect(read(`src/lib/i18n/locales/${lng}.ts`), lng).toMatch(
        /overDogCap: ".*\{\{dogs\}\}.*\{\{cap\}\}.*"/,
      );
    }
    expect(read("src/components/my-day/WalkParts.tsx")).toContain(
      't("walk.overDogCap", { dogs: overCap.dogs, cap: overCap.cap })',
    );
  });
});
