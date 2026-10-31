// The notes the office typed when booking a stay reach the sitter (#618).
//
// They were written to stays.notes and read by nobody on a tech screen, so a
// sitter worked the nights without the meds and routines the office already
// had. Now withSitDay reads them as the caller and every night's card draws
// them at the top, outside the collapse, in full.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (f: unknown) => f,
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    const chain: any = () => chain;
    chain.validator = () => chain;
    chain.inputValidator = () => chain;
    chain.middleware = () => chain;
    chain.handler = () => chain;
    return chain;
  },
  createMiddleware: () => {
    const chain: any = {};
    chain.server = () => chain;
    chain.client = () => chain;
    chain.middleware = () => chain;
    return chain;
  },
}));

import i18n from "@/lib/i18n";
import { SitStayNotes } from "@/components/my-day/SitParts";
import { withSitDay } from "@/lib/sit-day.server";
import type { SitFacts } from "@/lib/sit-day";

const ROOT = join(__dirname, "..");
const STAY = "stay-1";
const NOTE =
  "Insulin 2 units at 8pm with food. Luna hides under the guest bed; do not pull her out.";

const facts = (visit_id: string, n: number): SitFacts => ({
  visit_id,
  stay_id: STAY,
  kind: "overnight",
  starts_on: "2026-11-02",
  ends_on: "2026-11-06",
  pet_ids: ["luna"],
  visit_number: n,
  visit_total: 4,
  window_earliest: "18:00:00",
  window_latest: "20:00:00",
});

const SIT_SERVICE = { name: "House sit", service_line: "pet_sitting" };

/** A client that answers what withSitDay asks, and records what it read. */
function fakeSupabase(notes: string | null) {
  const reads: string[] = [];
  const query = (rows: unknown[]) => {
    const q: any = {
      select: () => q,
      in: () => q,
      order: () => q,
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(ok, bad),
    };
    return q;
  };
  return {
    reads,
    client: {
      rpc: (name: string, args: { _visit_ids?: string[] }) => {
        reads.push(`rpc:${name}`);
        if (name === "sit_visit_facts")
          return Promise.resolve({
            data: (args._visit_ids ?? []).map((id, i) => facts(id, i + 1)),
            error: null,
          });
        return Promise.resolve({ data: [], error: null });
      },
      from: (table: string) => {
        reads.push(`from:${table}`);
        if (table === "stays") return query([{ id: STAY, notes }]);
        return query([]);
      },
    } as any,
  };
}

describe("withSitDay", () => {
  it("puts the stay's notes on every night of the stay", async () => {
    const { client, reads } = fakeSupabase(`  ${NOTE}\n`);
    const nights = ["n1", "n2", "n3", "n4"].map((id) => ({
      id,
      services: SIT_SERVICE,
      properties: { dogs: [] },
    }));
    const out = await withSitDay(client, nights);
    expect(out.map((v) => v.stay_notes)).toEqual([NOTE, NOTE, NOTE, NOTE]);
    // Read as the caller, from the table, so the stays SELECT policy decides.
    expect(reads).toContain("from:stays");
  });

  it("leaves no notes block for a stay booked without notes", async () => {
    const { client } = fakeSupabase("   ");
    const [v] = await withSitDay(client, [
      { id: "n1", services: SIT_SERVICE, properties: { dogs: [] } },
    ]);
    expect(v.stay_notes).toBeNull();
  });

  it("asks nothing for a day with no pet sitting stop", async () => {
    const { client, reads } = fakeSupabase(NOTE);
    await withSitDay(client, [
      { id: "w1", services: { name: "Scoop", service_line: "pet_waste" }, properties: {} },
    ]);
    expect(reads).toEqual([]);
  });
});

/** The last migration that (re)defines a given SQL object. */
function lastDefinition(pattern: RegExp): string {
  const dir = join(ROOT, "supabase/migrations");
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .filter((sql) => pattern.test(sql));
  expect(hits.length).toBeGreaterThan(0);
  return hits[hits.length - 1];
}

describe("who may read the notes", () => {
  it("the stays SELECT policy admits anyone with a visit at the stay's property", () => {
    const sql = lastDefinition(/CREATE POLICY "Members read stays" ON public\.stays/);
    const policy = sql.slice(sql.indexOf('CREATE POLICY "Members read stays"'));
    expect(policy.slice(0, 400)).toMatch(/may_read_property_row\(organization_id, property_id\)/);
  });

  it("may_read_property_row lets in the sitter assigned that night, which covers a handoff", () => {
    const sql = lastDefinition(/FUNCTION public\.may_read_property_row\(_org_id uuid/);
    const fn = sql.slice(sql.indexOf("FUNCTION public.may_read_property_row(_org_id uuid"));
    expect(fn.slice(0, 800)).toMatch(
      /v\.property_id = _property_id\s+AND s\.user_id = auth\.uid\(\)/,
    );
  });
});

describe("the card", () => {
  const root = new Map<string, string>([["lang", "en"]]);
  beforeAll(() => {
    vi.stubGlobal("document", {
      documentElement: {
        getAttribute: (k: string) => root.get(k) ?? null,
        setAttribute: (k: string, v: string) => void root.set(k, v),
      },
    });
  });
  afterAll(async () => {
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  });

  const visit = { id: "n2", sit_facts: facts("n2", 2), stay_notes: NOTE };

  it("draws the whole note with nothing to open", async () => {
    await i18n.changeLanguage("en");
    const html = renderToStaticMarkup(createElement(SitStayNotes, { visit }));
    expect(html).toContain("Stay notes");
    expect(html).toContain(NOTE.replace(/'/g, "&#x27;"));
    expect(html).not.toMatch(/line-clamp|<details|aria-expanded|truncate/);
  });

  it("draws nothing when there is no note", () => {
    const html = renderToStaticMarkup(
      createElement(SitStayNotes, { visit: { ...visit, stay_notes: null } }),
    );
    expect(html).toBe("");
  });

  it("speaks the tech's language and spells sides logically", async () => {
    for (const lng of ["es", "ar", "zh"]) {
      await i18n.changeLanguage(lng);
      const html = renderToStaticMarkup(createElement(SitStayNotes, { visit }));
      expect(html).not.toContain("Stay notes");
      expect(html).toContain("<bdi>");
      for (const cls of html.match(/class="([^"]*)"/g) ?? []) {
        expect(cls).not.toMatch(/\b(ml|mr|pl|pr|left|right)-|text-(left|right)\b/);
      }
    }
  });

  it("sits at the top of the stay, outside the collapse, on My Day", () => {
    const src = readFileSync(join(ROOT, "src/routes/_authenticated/my-day.tsx"), "utf8");
    const meta = src.indexOf("{sit && <SitMeta visit={visit} locale={locale} />}");
    const notes = src.indexOf("{sit && <SitStayNotes visit={visit} />}");
    const fold = src.indexOf("{!collapsed && (", meta);
    expect(meta).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(meta);
    expect(notes).toBeLessThan(fold);
    expect(src.indexOf("<SitPetsCare")).toBeGreaterThan(notes);
  });
});
