// #617, measured on a real database: /clients and the client search at 5,000
// clients, as the signed-in owner, with real RLS on the gate.
//
// OPT-IN ONLY. CI's test job shares a local database with other branches, so
// this never seeds and never runs by itself. To run it:
//   1. supabase start, then npm run test:e2e:seed (prints the org id)
//   2. psql ... -v org="'<org id>'" -f tests/support/clients-at-scale.seed.sql
//   3. CLIENTS_AT_SCALE=1 SUPABASE_URL=http://127.0.0.1:54421 \
//      SERVICE_ROLE_KEY=<local service_role JWT> SCALE_ANON_KEY=<local anon JWT> \
//      npx vitest run tests/clients-at-scale.test.ts
//
// The dispatcher pass checks the other half of the claim in directoryReader:
// the service-role read returns exactly the clients RLS gives that role, and
// no invoice data, since the invoices policy does not let a dispatcher read
// any. It creates (or reuses) dispatcher@scale.houndstack.test in the E2E org.
//
// First run, 2026-10-31, in a cloud container against the replayed
// migrations. Read through RLS, the page hit the statement timeout, the tiles
// took 4.3-4.8 s and a picker 3.3-29 s; read with the service role behind
// the gate (directoryReader), the page took 0.15-0.40 s, the tiles 40-130 ms
// and every search under 0.4 s. What this does not measure is the deployed
// Worker's own distance from its database.

import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

const ENABLED = process.env.CLIENTS_AT_SCALE === "1";
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

const state = vi.hoisted(() => ({ supabase: null as any, userId: "" }));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    const b: any = {
      middleware: () => b,
      inputValidator: (v: any) => ((b.v = v), b),
      handler: (h: any) => (input: any) =>
        h({
          data: b.v ? b.v(input?.data) : input?.data,
          context: { supabase: state.supabase, userId: state.userId },
        }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import { listClientsPage, listClientsSummary, searchClients } from "@/lib/clients.functions";

describe.skipIf(!ENABLED)("/clients at 5,000 clients on a real database", () => {
  it("answers in under 2 s and sends no URL over 2 KB", async () => {
    const url = process.env.SUPABASE_URL ?? "";
    // The service-role reads go wherever SUPABASE_URL points. Refuse
    // anything but a local stack.
    expect(LOCAL.test(url), `SUPABASE_URL must be a local stack, got ${url}`).toBe(true);

    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((i: any, init?: any) => {
      seen.push(String(i instanceof Request ? i.url : i));
      return real(i, init);
    }) as typeof fetch;
    try {
      const sb = createClient(url, process.env.SCALE_ANON_KEY!, { auth: { persistSession: false } });
      const { data, error } = await sb.auth.signInWithPassword({
        email: "owner@e2e.houndstack.test",
        password: "e2e-owner-password-1",
      });
      if (error) throw error;
      state.supabase = sb;
      state.userId = data.user!.id;

      const timed = async <T>(fn: () => Promise<T>) => {
        const t = performance.now();
        const r = await fn();
        return { r, ms: performance.now() - t };
      };
      // What the browser asks for on opening /clients: the page and the tiles.
      const first = await timed(() =>
        Promise.all([listClientsPage({ data: {} }), listClientsSummary()]),
      );
      expect(first.r[1].stats.total).toBeGreaterThanOrEqual(5_000);
      expect(first.r[0].rows).toHaveLength(50);
      expect(first.ms).toBeLessThan(2_000);
      const search = await timed(() => listClientsPage({ data: { q: "jose nunez" } }));
      expect(search.r.matched).toBeGreaterThan(0);
      expect(search.ms).toBeLessThan(2_000);
      for (const q of ["", "jose", "555-0042", "harbor", "4400 oak", "job-4990"]) {
        const pick = await timed(() => searchClients({ data: { q, limit: 20 } }));
        expect(pick.ms, q).toBeLessThan(2_000);
      }
      console.log(`first page ${first.ms.toFixed(0)} ms, search ${search.ms.toFixed(0)} ms`);
      for (const u of seen) expect(u.length, u.slice(0, 120)).toBeLessThan(2_048);
    } finally {
      globalThis.fetch = real;
    }
  }, 120_000);

  it("as a dispatcher: the same clients RLS gives, and no invoice data", async () => {
    const url = process.env.SUPABASE_URL ?? "";
    expect(LOCAL.test(url), `SUPABASE_URL must be a local stack, got ${url}`).toBe(true);
    const admin = createClient(url, process.env.SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const owner = createClient(url, process.env.SCALE_ANON_KEY!, { auth: { persistSession: false } });
    const { data: o } = await owner.auth.signInWithPassword({
      email: "owner@e2e.houndstack.test",
      password: "e2e-owner-password-1",
    });
    const { data: role } = await admin
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", o.user!.id)
      .single();
    const orgId = role!.organization_id as string;

    const email = "dispatcher@scale.houndstack.test";
    const password = "scale-dispatcher-password-1";
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    let user = list.users.find((u) => u.email === email);
    if (!user) {
      const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (made.error) throw made.error;
      user = made.data.user!;
    }
    const has = await admin.from("user_roles").select("user_id").eq("user_id", user.id).maybeSingle();
    if (!has.data) {
      const made = await admin
        .from("user_roles")
        .insert({ user_id: user.id, organization_id: orgId, role: "dispatcher" });
      if (made.error) throw new Error(`could not make the dispatcher: ${made.error.message}`);
    }

    const sb = createClient(url, process.env.SCALE_ANON_KEY!, { auth: { persistSession: false } });
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    state.supabase = sb;
    state.userId = data.user!.id;

    // What RLS gives this dispatcher, read the slow way, a page at a time.
    const rlsIds = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const r = await sb.from("clients").select("id").order("id").range(from, from + 999);
      if (r.error) throw r.error;
      for (const c of r.data ?? []) rlsIds.add(c.id);
      if ((r.data ?? []).length < 1000) break;
    }
    const rlsInvoices = await sb.from("invoices").select("id").limit(1);
    expect(rlsInvoices.data ?? []).toEqual([]);

    const t = performance.now();
    const [page, summary] = await Promise.all([listClientsPage({ data: {} }), listClientsSummary()]);
    const ms = performance.now() - t;
    const all = await listClientsPage({ data: { all: true } });
    expect(new Set(all.rows.map((r: any) => r.id))).toEqual(rlsIds);
    expect(summary.stats.total).toBe(rlsIds.size);
    expect(page.rows).toHaveLength(50);
    expect(ms).toBeLessThan(2_000);
    for (const rows of [page.rows, all.rows]) {
      expect(rows.every((r: any) => r.outstanding_cents === 0)).toBe(true);
    }
    expect(summary.stats).toMatchObject({ outstanding: 0, owedTotal: 0 });
    expect(await listClientsPage({ data: { status: "outstanding" } })).toMatchObject({ matched: 0 });
    console.log(`dispatcher: ${rlsIds.size} clients, first load ${ms.toFixed(0)} ms`);
  }, 180_000);
});
