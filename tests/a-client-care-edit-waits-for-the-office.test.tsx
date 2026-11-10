// #611 (R2-03): a client's care edit from the portal waits for the office.
//
// portal_request_stay used to upsert pet_care_instructions, the live sitter
// card, when a client sent a stay request, so a dose changed for a December
// stay changed tonight's card. Migration 20261031130000 stages the edit on
// stays.requested_care and confirm_stay applies it. This holds the SQL and
// the screens to that; tests/integration/a-client-care-edit-waits-for-the-
// office.db.test.ts proves it in a real database.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { migrationFiles, readMigration, stripLineComments } from "./support/sql-migrations";

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
import { SitPetsCare } from "@/components/my-day/SitParts";
import { sitPets } from "@/lib/sit-day";
import { medLine, readRequestedCare } from "@/lib/stays";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const MIGRATION = "20261031130000_a-client-care-edit-waits-for-the-office.sql";
const DISPATCHER_MIGRATION = "20261109120000_a-dispatcher-books-a-stay-at-the-set-price.sql";

/** The body of the last CREATE OR REPLACE of `fn` across every migration. */
function latestBody(fn: string): { file: string; body: string } {
  let found: { file: string; body: string } | null = null;
  const head = new RegExp(String.raw`CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.${fn}\s*\(`, "i");
  for (const file of migrationFiles()) {
    const sql = stripLineComments(readMigration(file));
    const m = head.exec(sql);
    if (!m) continue;
    const start = sql.indexOf("$function$", m.index);
    const end = sql.indexOf("$function$", start + 10);
    found = { file, body: sql.slice(start + 10, end) };
  }
  if (!found) throw new Error(`${fn} is not defined`);
  return found;
}

describe("the database stages a client's care edit and applies it at confirm", () => {
  it("portal_request_stay never writes the live care card", () => {
    const { file, body } = latestBody("portal_request_stay");
    expect(file).toBe(MIGRATION);
    expect(body).not.toMatch(/pet_care_instructions\s*\(/i);
    expect(body).not.toMatch(/INSERT\s+INTO\s+public\.pet_care_instructions/i);
    expect(body).not.toMatch(/UPDATE\s+public\.pet_care_instructions/i);
    expect(body).toMatch(/requested_care/);
    // Checked when sent, so the office confirm cannot fail on them later.
    expect(body).toMatch(/pet_meds_are_valid\(_meds\)/);
  });

  it("confirm_stay applies staged care before the snapshot, and marks it as the client's", () => {
    const { file, body } = latestBody("confirm_stay");
    // 20261109120000 restates confirm_stay to let a dispatcher confirm at the
    // set price; its body is this file's but for that one permission block
    // (pinned in tests/a-dispatcher-books-a-stay-and-a-client-adds-a-cat).
    expect(file).toBe(DISPATCHER_MIGRATION);
    const apply = body.indexOf("_st.requested_care");
    const snapshot = body.indexOf("SET care_snapshot");
    const confirmed = body.indexOf("SET status = 'confirmed'");
    expect(apply).toBeGreaterThan(0);
    expect(apply).toBeLessThan(snapshot);
    expect(snapshot).toBeLessThan(confirmed);
    expect(body).toMatch(/client_updated_at,\s*client_updated_stay_id\)/);
    expect(body).toMatch(/NOT \(_pet = ANY\(_st\.pet_ids\)\)/);
    expect(body).toContain("Only a requested stay can be confirmed.");
  });

  it("an office edit to the care clears the client marker", () => {
    const { file, body } = latestBody("tg_pet_care_instructions_pet");
    expect(file).toBe(MIGRATION);
    expect(body).toMatch(/NEW\.client_updated_at := NULL/);
  });

  it("keeps the privilege guards and ends with a self-check", () => {
    const sql = readMigration(MIGRATION);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.portal_request_stay\(uuid, uuid, uuid, jsonb\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.portal_request_stay\(uuid, uuid, uuid, jsonb\) TO service_role;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.confirm_stay\(uuid, integer, integer\) FROM PUBLIC, anon;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.tg_pet_care_instructions_pet\(\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql.trimEnd()).toMatch(/DO \$check\$[\s\S]*\$check\$;$/);
  });
});

describe("the screens say what happens", () => {
  it("the portal says care changes apply after the office confirms", () => {
    const src = read("src/components/portal/Stays.tsx");
    expect(src).not.toContain("Edits are saved for your pet's future care");
    expect(src.replace(/\s+/g, " ")).toContain(
      "Care changes are sent to the office with this request. They apply after the office confirms it.",
    );
  });

  it("the office sees the staged changes on the confirm control", () => {
    expect(read("src/lib/stay-booking.functions.ts")).toMatch(
      /careChanges: await requestedCareChanges/,
    );
    expect(read("src/components/client-detail/ConfirmStayButton.tsx")).toContain(
      "data-stay-care-changes",
    );
  });

  it("reads staged care, keeping only the fields the client changed", () => {
    expect(
      readRequestedCare([
        {
          pet_id: "p1",
          meds: [{ name: "Insulin", dose: "4 units", times: ["08:00", "20:00"], notes: null }],
        },
        { pet_id: "p2", feeding: null, other_care: "Plants on Sunday" },
        { nope: true },
      ]),
    ).toEqual([
      {
        petId: "p1",
        meds: [{ name: "Insulin", dose: "4 units", times: ["08:00", "20:00"], notes: null }],
      },
      { petId: "p2", feeding: null, otherCare: "Plants on Sunday" },
    ]);
    expect(readRequestedCare(null)).toEqual([]);
    expect(
      medLine({ name: "Insulin", dose: "4 units", times: ["08:00", "20:00"], notes: null }),
    ).toBe("Insulin, 4 units, at 8 AM, 8 PM");
  });
});

describe("the sitter card says the client updated the care", () => {
  afterAll(() => i18n.changeLanguage("en"));

  const rows = [
    {
      id: "luna",
      name: "Luna",
      species: "cat",
      active: true,
      pet_care_instructions: {
        feeding: "Half a cup",
        meds: [{ name: "Insulin", dose: "4 units", times: ["08:00"], notes: null }],
        other_care: null,
        client_updated_at: "2026-10-30T15:00:00Z",
      },
    },
    {
      id: "max",
      name: "Max",
      species: "dog",
      active: true,
      pet_care_instructions: {
        feeding: "One cup",
        meds: [],
        other_care: null,
        client_updated_at: null,
      },
    },
  ];

  it("maps the marker, and only on the pet it belongs to", () => {
    const [luna, max] = sitPets(rows, null);
    expect(luna.clientUpdatedAt).toBe("2026-10-30T15:00:00Z");
    expect(max.clientUpdatedAt).toBeNull();
  });

  it("renders Updated by client <date> in every language", async () => {
    const expected: Record<string, string> = {
      en: "Updated by client Oct 30",
      es: "Actualizado por el cliente el",
      ar: "حدّثه العميل في",
      zh: "客户于",
    };
    for (const [lng, text] of Object.entries(expected)) {
      await i18n.changeLanguage(lng);
      const html = renderToStaticMarkup(
        createElement(SitPetsCare, {
          pets: sitPets(rows, null),
          tz: "America/Chicago",
          locale: lng === "en" ? "en-US" : lng,
        }),
      );
      expect(html.match(/data-care-updated-by-client="([^"]+)"/g)).toEqual([
        'data-care-updated-by-client="luna"',
      ]);
      expect(html).toContain(text);
    }
  });
});
