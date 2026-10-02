// A dead endpoint is retried, then switched off.
//
// A delivery that does not get a 2xx is tried again after 1m, 5m, 30m, 2h and
// 12h, and after the sixth attempt fails it is marked failed. Five deliveries
// in a row ending failed switch the endpoint off and tell the owners, once.
//
// The schedule is TypeScript (planAfterAttempt); the counting is SQL
// (webhook_record_attempt), because two worker runs incrementing the same
// counter must not lose an increment. This file checks the TypeScript half
// directly, checks the worker hands the SQL half what it needs, and reads the
// SQL. tests/nothing-could-listen-for-a-completed-visit.test.ts then proves
// the SQL half in a real Postgres.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_DISABLE_AFTER,
  MAX_ATTEMPTS,
  RETRY_DELAYS_SECONDS,
  planAfterAttempt,
  processWebhookDeliveries,
  shouldAutoDisable,
  type RpcClient,
  type WorkerDeps,
} from "@/lib/webhook-delivery.server";

const NOW = new Date("2026-09-29T12:00:00Z");
const minutes = (d: Date | null) => (d ? (d.getTime() - NOW.getTime()) / 60_000 : null);

describe("the retry schedule", () => {
  it("is 1m, 5m, 30m, 2h, 12h", () => {
    expect(RETRY_DELAYS_SECONDS).toEqual([60, 300, 1800, 7200, 43200]);
    expect(MAX_ATTEMPTS).toBe(6);
  });

  it("waits the right time after each failed attempt, then gives up", () => {
    const after = [1, 2, 3, 4, 5].map((n) => planAfterAttempt(n, false, NOW));
    expect(after.map((p) => p.final)).toEqual([false, false, false, false, false]);
    expect(after.map((p) => minutes(p.nextAttemptAt))).toEqual([1, 5, 30, 120, 720]);

    const sixth = planAfterAttempt(6, false, NOW);
    expect(sixth).toEqual({ succeeded: false, final: true, nextAttemptAt: null });
    // A delivery claimed past its budget (a crashed run's row coming back)
    // is not given more.
    expect(planAfterAttempt(9, false, NOW).final).toBe(true);
  });

  it("stops on the first success, whenever it comes", () => {
    for (const n of [1, 3, 6]) {
      expect(planAfterAttempt(n, true, NOW)).toEqual({
        succeeded: true,
        final: true,
        nextAttemptAt: null,
      });
    }
  });
});

describe("switching an endpoint off", () => {
  it("happens at five failed deliveries in a row, not before", () => {
    expect(AUTO_DISABLE_AFTER).toBe(5);
    expect([1, 2, 3, 4].map(shouldAutoDisable)).toEqual([false, false, false, false]);
    expect(shouldAutoDisable(5)).toBe(true);
  });

  const sql = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "supabase/migrations/20260929080000_nothing-could-listen-for-a-completed-visit.sql",
    ),
    "utf8",
  );
  const record = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.webhook_record_attempt"),
    sql.indexOf("REVOKE ALL ON FUNCTION public.webhook_record_attempt"),
  );

  it("is counted in SQL, atomically, and only for deliveries that used every retry", () => {
    expect(record).toMatch(/consecutive_failures = e\.consecutive_failures \+ 1/);
    expect(record).toMatch(/ELSIF _final AND _type <> 'webhook\.test' THEN/);
    expect(record).toMatch(
      /enabled = CASE WHEN e\.consecutive_failures \+ 1 >= GREATEST\(_disable_after, 1\) THEN false/,
    );
    // Any success resets the count.
    expect(record).toMatch(
      /IF _succeeded THEN\s+UPDATE public\.webhook_endpoints e\s+SET consecutive_failures = 0/,
    );
  });

  it("reports whether THIS call switched it off, so the owner is told once", () => {
    expect(record).toMatch(
      /'disabled_now', COALESCE\(_was_enabled AND _now_enabled IS FALSE, false\)/,
    );
  });
});

// ── The worker, against a fake database ─────────────────────────────────────

type Row = {
  delivery_id: string;
  organization_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret_ciphertext: string | null;
};

function row(over: Partial<Row> = {}): Row {
  return {
    delivery_id: "d1",
    organization_id: "org1",
    endpoint_id: "ep1",
    event_id: "e1",
    event_type: "visit.completed",
    payload: { id: "e1", type: "visit.completed" },
    attempts: 1,
    url: "https://hooks.example.com/in",
    secret_ciphertext: "v1.a.b.c",
    ...over,
  };
}

function fakeDb(
  rows: Row[],
  recordAnswer: (args: Record<string, unknown>) => unknown = () => ({ recorded: true }),
) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      if (fn === "webhook_claim_deliveries") return Promise.resolve({ data: rows, error: null });
      if (fn === "webhook_record_attempt")
        return Promise.resolve({ data: recordAnswer(args), error: null });
      return Promise.resolve({ data: null, error: { message: `unexpected ${fn}` } });
    },
  };
  return {
    client,
    calls,
    records: () => calls.filter((c) => c.fn === "webhook_record_attempt").map((c) => c.args),
  };
}

function workerDeps(
  status: number,
  over: Partial<WorkerDeps> = {},
): WorkerDeps & { notifyDisabled: ReturnType<typeof vi.fn> } {
  return {
    fetch: (async () => new Response(null, { status })) as unknown as typeof fetch,
    resolve: async () => ["93.184.216.34"],
    now: () => NOW,
    decrypt: (c: string) => `whsec_decrypted_${c.length}`,
    notifyDisabled: vi.fn(async () => {}),
    ...over,
  } as WorkerDeps & { notifyDisabled: ReturnType<typeof vi.fn> };
}

describe("the worker", () => {
  it("records a retry with the next time on the schedule", async () => {
    const db = fakeDb([row({ attempts: 2 })]);
    const s = await processWebhookDeliveries(db.client, workerDeps(500));
    expect(s).toMatchObject({ claimed: 1, retrying: 1, failed: 0, succeeded: 0 });
    const [rec] = db.records();
    expect(rec).toMatchObject({
      _succeeded: false,
      _final: false,
      _status_code: 500,
      _disable_after: 5,
    });
    expect(rec._next_attempt_at).toBe(new Date(NOW.getTime() + 300_000).toISOString());
  });

  it("marks the sixth failure final", async () => {
    const db = fakeDb([row({ attempts: 6 })]);
    const s = await processWebhookDeliveries(db.client, workerDeps(503));
    expect(s.failed).toBe(1);
    expect(db.records()[0]).toMatchObject({
      _succeeded: false,
      _final: true,
      _next_attempt_at: null,
    });
  });

  it("records a success", async () => {
    const db = fakeDb([row()]);
    const s = await processWebhookDeliveries(db.client, workerDeps(200));
    expect(s.succeeded).toBe(1);
    expect(db.records()[0]).toMatchObject({
      _succeeded: true,
      _final: true,
      _status_code: 200,
      _error: null,
    });
  });

  it("notifies once when the database says this failure switched the endpoint off", async () => {
    const db = fakeDb([row({ attempts: 6 })], () => ({
      recorded: true,
      disabled_now: true,
      consecutive_failures: 5,
    }));
    const deps = workerDeps(500);
    const s = await processWebhookDeliveries(db.client, deps);
    expect(s.disabled).toBe(1);
    expect(deps.notifyDisabled).toHaveBeenCalledTimes(1);
    expect(deps.notifyDisabled).toHaveBeenCalledWith({
      orgId: "org1",
      endpointId: "ep1",
      url: "https://hooks.example.com/in",
      failures: 5,
    });
  });

  it("does not notify for a failure that did not switch anything off", async () => {
    const db = fakeDb([row({ attempts: 6 })], () => ({
      recorded: true,
      disabled_now: false,
      consecutive_failures: 3,
    }));
    const deps = workerDeps(500);
    await processWebhookDeliveries(db.client, deps);
    expect(deps.notifyDisabled).not.toHaveBeenCalled();
  });

  it("tries a test event once and never lets it switch an endpoint off", async () => {
    const db = fakeDb([row({ event_type: "webhook.test", attempts: 1 })], () => ({
      recorded: true,
      disabled_now: true,
    }));
    const deps = workerDeps(500);
    await processWebhookDeliveries(db.client, deps, { only: "d1" });
    expect(db.calls[0]).toMatchObject({
      fn: "webhook_claim_deliveries",
      args: { _limit: 1, _only: "d1" },
    });
    expect(db.records()[0]).toMatchObject({ _final: true });
    expect(deps.notifyDisabled).not.toHaveBeenCalled();
  });

  it("records a failure without sending when the secret cannot be read", async () => {
    const fetch = vi.fn();
    const db = fakeDb([row({ secret_ciphertext: null }), row({ delivery_id: "d2" })]);
    const deps = workerDeps(200, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      decrypt: () => {
        throw new Error("bad key");
      },
    });
    await processWebhookDeliveries(db.client, deps);
    expect(fetch).not.toHaveBeenCalled();
    const errors = db.records().map((r) => r._error);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/no signing secret/),
        expect.stringMatching(/bad key/),
      ]),
    );
  });

  it("claims with a lease and a bounded batch", async () => {
    const db = fakeDb([]);
    await processWebhookDeliveries(db.client, workerDeps(200));
    expect(db.calls[0]).toMatchObject({
      fn: "webhook_claim_deliveries",
      args: { _limit: 20, _lease_seconds: 120, _only: null },
    });
  });
});
