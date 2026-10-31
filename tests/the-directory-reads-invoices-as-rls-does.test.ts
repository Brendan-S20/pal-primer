// #617 review: /clients reads the directory with the service role, behind
// requirePermission(view_client_directory). Every table it reads is visible to
// the whole organization under that permission, except invoices, whose read
// policies ask for more. directoryReader decides in TypeScript who may see
// invoices (`seesInvoices`). This pins that decision to the policies
// themselves, so a migration that widens or narrows who reads invoices fails
// here until the TypeScript agrees.
//
// The policies are followed through the migrations in order: CREATE, ALTER
// and DROP of every permissive policy on public.invoices that grants SELECT
// (FOR SELECT or FOR ALL). What they let through must be has_permission()
// on the caller's organization and nothing else, and the permissions named
// must be exactly the ones directoryReader checks.
//
// The other half of the rule, which rows a caller who passes the directory
// gate may read on clients, properties, dogs and subscriptions, is
// permission-parity's: those policies are has_permission(...,
// 'view_client_directory'), whose role map ROLE_PERMISSIONS mirrors.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  migrationFiles,
  readMigration,
  statements,
  stripLineComments,
} from "./support/sql-migrations";

const root = join(import.meta.dirname, "..");

type Policy = { cmd: string; permissive: boolean; using: string };

/** The read policies on public.invoices as the migrations leave them. */
function invoiceReadPolicies(): Map<string, Policy> {
  const live = new Map<string, Policy>();
  for (const f of migrationFiles()) {
    for (const st of statements(stripLineComments(readMigration(f)))) {
      const flat = st.replace(/\s+/g, " ").trim();
      const create = flat.match(
        /^CREATE POLICY (?:"([^"]+)"|(\w+)) ON (?:public\.)?invoices\b(.*)$/i,
      );
      if (create) {
        const name = create[1] ?? create[2];
        const rest = create[3];
        const cmd = (rest.match(/\bFOR (SELECT|INSERT|UPDATE|DELETE|ALL)\b/i)?.[1] ?? "ALL").toUpperCase();
        const permissive = !/\bAS RESTRICTIVE\b/i.test(rest);
        const using = rest.match(/\bUSING \((.*)\)(?: WITH CHECK|$)/i)?.[1] ?? "";
        live.set(name, { cmd, permissive, using });
        continue;
      }
      const alter = flat.match(/^ALTER POLICY (?:"([^"]+)"|(\w+)) ON (?:public\.)?invoices\b(.*)$/i);
      const altered = alter ? (alter[1] ?? alter[2]) : null;
      if (alter && altered && live.has(altered)) {
        const using = alter[3].match(/\bUSING \((.*)\)(?: WITH CHECK|$)/i)?.[1];
        if (using != null) live.set(altered, { ...live.get(altered)!, using });
        continue;
      }
      const drop = flat.match(/^DROP POLICY (?:IF EXISTS )?(?:"([^"]+)"|(\w+)) ON (?:public\.)?invoices\b/i);
      if (drop) live.delete(drop[1] ?? drop[2]);
    }
  }
  return live;
}

describe("who reads invoices on /clients is who RLS lets read them", () => {
  const readers = [...invoiceReadPolicies().entries()].filter(
    ([, p]) => p.permissive && (p.cmd === "SELECT" || p.cmd === "ALL"),
  );

  it("finds the invoice read policies", () => {
    expect(readers.map(([name]) => name).sort()).toContain(
      "invoices readable by billing and finance roles",
    );
  });

  it("they let through has_permission on the caller's organization, and nothing else", () => {
    for (const [name, p] of readers) {
      const rest = p.using
        .replace(
          /has_permission\(\s*\(\s*select auth\.uid\(\)(?: AS uid)?\s*\)\s*,\s*(?:invoices\.)?organization_id\s*,\s*'[a-z_]+'(?:::text)?\s*\)/gi,
          "",
        )
        .replace(/\b(OR)\b|[()\s]/gi, "");
      expect(rest, `"${name}" grants reads on something other than has_permission: ${p.using}`).toBe("");
    }
  });

  it("directoryReader's seesInvoices names exactly those permissions", () => {
    const granted = new Set<string>();
    for (const [, p] of readers) {
      for (const m of p.using.matchAll(/'([a-z_]+)'(?:::text)?\s*\)/g)) granted.add(m[1]);
    }
    const src = readFileSync(join(root, "src/lib/clients.functions.ts"), "utf8");
    const reader = src.slice(
      src.indexOf("async function directoryReader"),
      src.indexOf("async function loadClientRoster"),
    );
    const checked = new Set(
      [...reader.matchAll(/hasPermission\(caller\.role, "([a-z_]+)"\)/g)].map((m) => m[1]),
    );
    expect([...checked].sort()).toEqual([...granted].sort());
  });
});

describe("the service role is reached only through the directory gate", () => {
  it("clients.functions.ts uses supabaseAdmin in directoryReader and getFieldClientInfo only", () => {
    const src = readFileSync(join(root, "src/lib/clients.functions.ts"), "utf8");
    // Every function or server function the file defines, by its own name.
    const starts = [
      ...src.matchAll(
        /^(?:export const (\w+) = createServerFn|(?:export )?async function (\w+)|(?:export )?function (\w+)|let (\w+)|(?:export )?const (\w+) = (?:async )?(?:\([^)]*\)|\w+) =>)/gm,
      ),
    ].map((m) => ({ name: m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5], at: m.index! }));
    const owners = new Set<string>();
    for (const m of src.matchAll(/supabaseAdmin|integrations\/supabase\/client\.server/g)) {
      const owner = starts.filter((s) => s.at < m.index!).pop();
      owners.add(owner?.name ?? "(top of file)");
    }
    // serviceRoleModule is directoryReader's own cached import of the module.
    expect([...owners].sort()).toEqual([
      "directoryReader",
      "getFieldClientInfo",
      "serviceRoleModule",
    ]);
  });

  it("every read made with the directory client is filtered by the caller's organization", () => {
    const src = readFileSync(join(root, "src/lib/clients.functions.ts"), "utf8");
    const body = (name: string, end: string) => src.slice(src.indexOf(name), src.indexOf(end));
    // The page by id, the summary's tags and the search are the reads that
    // do not go through applyClientFilters or loadClientRoster.
    for (const [name, end] of [
      ["export const listClientsPage", "export const listClientsSummary"],
      ["export const listClientsSummary", "const searchClientsSchema"],
      ["export const searchClients", "const createClientSchema"],
    ]) {
      const fn = body(name, end);
      const froms = fn.match(/\.from\("(clients|invoices)"\)/g) ?? [];
      const orgFilters = fn.match(/\.eq\("organization_id", orgId\)|applyClientFilters\(/g) ?? [];
      expect(orgFilters.length, name).toBeGreaterThanOrEqual(froms.length ? 1 : 0);
    }
  });
});
