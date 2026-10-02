// A webhook could not say who to contact.
//
// Payloads carry ids, names, amounts and dates and never an email or phone
// (tests/nothing-could-listen-for-a-completed-visit.test.ts holds that line
// for what the triggers write). The commonest thing an owner builds with a
// webhook — new client into a mailing list, completed visit into a review
// request — needs exactly those two fields, so each endpoint now has an
// "Include customer email and phone" option, off by default, and the worker
// adds `data.contact` at send time for an endpoint that ticked it.
//
// This file checks the worker half with a fake database, reads the
// migration, and runs tests/sql/a-webhook-could-not-say-who-to-contact.proof.sql
// against the local stack for the half only Postgres can answer: off by
// default, own business only, callable by nobody but the service role.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  processWebhookDeliveries,
  verifyWebhookSignature,
  withContact,
  type ClaimedRow,
  type RpcClient,
  type WorkerDeps,
} from "@/lib/webhook-delivery.server";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20260929140000_a-webhook-could-not-say-who-to-contact.sql",
);
const BASE = join(
  ROOT,
  "supabase/migrations/20260929080000_nothing-could-listen-for-a-completed-visit.sql",
);
const PROOF = join(ROOT, "tests/sql/a-webhook-could-not-say-who-to-contact.proof.sql");
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

const CONTACT = { email: "pat@example.com", phone: "+15555550123" };

function row(over: Partial<ClaimedRow> = {}): ClaimedRow {
  return {
    delivery_id: "d1",
    organization_id: "org1",
    endpoint_id: "ep1",
    event_id: "e1",
    event_type: "client.created",
    payload: {
      id: "e1",
      type: "client.created",
      organization_id: "org1",
      data: { client_id: "c1", display_name: "Pat" },
    },
    attempts: 1,
    url: "https://hooks.example.com/in",
    secret_ciphertext: "v1.a.b.c",
    ...over,
  };
}

/** A database whose webhook_contact_for answers `contact` (null = the
 *  endpoint did not opt in) or fails with `contactError`. */
function fakeDb(rows: ClaimedRow[], contact: unknown, contactError?: string) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      if (fn === "webhook_claim_deliveries") return Promise.resolve({ data: rows, error: null });
      if (fn === "webhook_record_attempt")
        return Promise.resolve({ data: { recorded: true }, error: null });
      if (fn === "webhook_contact_for")
        return Promise.resolve(
          contactError
            ? { data: null, error: { message: contactError } }
            : { data: contact, error: null },
        );
      return Promise.resolve({ data: null, error: { message: `unexpected ${fn}` } });
    },
  };
  return { client, calls, of: (fn: string) => calls.filter((c) => c.fn === fn) };
}

function deps(sent: Array<{ body: string; headers: Headers }>): WorkerDeps {
  return {
    fetch: (async (_url: string, init: RequestInit) => {
      sent.push({ body: String(init.body), headers: new Headers(init.headers) });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch,
    resolve: async () => ["93.184.216.34"],
    now: () => new Date("2026-09-29T12:00:00Z"),
    decrypt: () => "whsec_test_secret",
    notifyDisabled: async () => {},
  };
}

describe("adding contact details at send time", () => {
  it("leaves the payload exactly as queued when the endpoint did not opt in", async () => {
    const r = row();
    const db = fakeDb([r], null);
    expect(await withContact(db.client, r)).toBe(r.payload);
    expect(db.of("webhook_contact_for")[0].args).toEqual({
      _endpoint_id: "ep1",
      _client_id: "c1",
      _lead_id: null,
    });
  });

  it("does not ask at all for an event about nobody", async () => {
    const r = row({
      event_type: "webhook.test",
      payload: { id: "e1", type: "webhook.test", data: { message: "hi" } },
    });
    const db = fakeDb([r], CONTACT);
    expect(await withContact(db.client, r)).toBe(r.payload);
    expect(db.of("webhook_contact_for")).toHaveLength(0);
  });

  it("adds data.contact, and keeps everything else, when the endpoint opted in", async () => {
    const r = row();
    const db = fakeDb([r], CONTACT);
    expect(await withContact(db.client, r)).toEqual({
      id: "e1",
      type: "client.created",
      organization_id: "org1",
      data: { client_id: "c1", display_name: "Pat", contact: CONTACT },
    });
  });

  it("asks about the lead only when there is no client", async () => {
    const lead = row({ payload: { data: { lead_id: "l1" } } });
    const db1 = fakeDb([lead], CONTACT);
    await withContact(db1.client, lead);
    expect(db1.of("webhook_contact_for")[0].args).toMatchObject({
      _client_id: null,
      _lead_id: "l1",
    });

    // An accepted quote names both; the client is who the business now deals with.
    const both = row({ payload: { data: { client_id: "c1", lead_id: "l1" } } });
    const db2 = fakeDb([both], CONTACT);
    await withContact(db2.client, both);
    expect(db2.of("webhook_contact_for")[0].args).toMatchObject({
      _client_id: "c1",
      _lead_id: null,
    });
  });

  it("signs the body it sends, contact included", async () => {
    const sent: Array<{ body: string; headers: Headers }> = [];
    const db = fakeDb([row()], CONTACT);
    const s = await processWebhookDeliveries(db.client, deps(sent));
    expect(s.succeeded).toBe(1);
    expect(JSON.parse(sent[0].body).data.contact).toEqual(CONTACT);
    const header = [...sent[0].headers.entries()].find(([k]) => k.endsWith("signature"))?.[1];
    expect(header).toBeTruthy();
    expect(
      verifyWebhookSignature("whsec_test_secret", header!, sent[0].body, {
        now: new Date("2026-09-29T12:00:00Z"),
      }),
    ).toBe(true);
  });

  it("does not send, and does not count against the endpoint, when the lookup fails", async () => {
    const sent: Array<{ body: string; headers: Headers }> = [];
    const db = fakeDb([row()], null, "connection reset");
    const s = await processWebhookDeliveries(db.client, deps(sent));
    expect(sent).toHaveLength(0);
    expect(db.of("webhook_record_attempt")).toHaveLength(0);
    expect(s).toMatchObject({ claimed: 1, succeeded: 0, failed: 0, retrying: 0 });
  });
});

describe("the migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("adds the option off by default and lets the office switch it", () => {
    expect(sql).toMatch(/include_contact boolean NOT NULL DEFAULT false/);
    expect(sql).toMatch(
      /GRANT UPDATE \(include_contact\) ON public\.webhook_endpoints TO authenticated/,
    );
    expect(sql).not.toMatch(/\bUPDATE public\.webhook_endpoints\b/);
  });

  it("gives the lookup to the service role and nobody else", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.webhook_contact_for\(uuid, uuid, uuid\) FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.webhook_contact_for\(uuid, uuid, uuid\) TO service_role;/,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.webhook_contact_for[^;]*\b(anon|authenticated)\b/,
    );
  });

  it("scopes both lookups to the endpoint's organization", () => {
    expect(sql).toMatch(/c\.id = _client_id AND c\.organization_id = _org/);
    expect(sql).toMatch(/l\.id = _lead_id AND l\.organization_id = _org/);
  });
});

describe("the page and the server functions", () => {
  const fns = readFileSync(join(ROOT, "src/lib/webhooks.functions.ts"), "utf8");
  const page = readFileSync(join(ROOT, "src/routes/_authenticated/settings.webhooks.tsx"), "utf8");

  it("default to off when creating, and pass the switch through when editing", () => {
    expect(fns).toMatch(/includeContact: z\.boolean\(\)\.default\(false\)/);
    expect(fns).toMatch(/include_contact: data\.includeContact/);
    expect(fns).toMatch(/patch\.include_contact = data\.includeContact/);
  });

  it("offer the option on both forms and show which endpoints have it on", () => {
    expect(page.match(/<ContactOption/g)).toHaveLength(2);
    expect(page).toMatch(/useState\(false\)/);
    expect(page).toMatch(/Includes email and phone/);
  });
});

// ── The proof, in a real Postgres ───────────────────────────────────────────

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the webhook contact proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("the contact rules hold in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [MIGRATION, BASE, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = spawnSync(
      psql!,
      [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-v", `base=${BASE}`, "-f", PROOF],
      { encoding: "utf8", timeout: 300_000 },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(5);
    expect(out).toMatch(/ALL CONTACT PROOFS PASSED/);
  });
});
