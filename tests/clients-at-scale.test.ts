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
});
