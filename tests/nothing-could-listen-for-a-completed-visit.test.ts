// Nothing could listen for a completed visit.
//
// Outbound webhooks (20260929080000): database triggers write an outbox, a
// cron-driven worker signs and sends it. This file reads the migration and
// the code that surrounds it, then runs
// tests/sql/nothing-could-listen-for-a-completed-visit.proof.sql against the
// local Supabase stack, which applies the migration inside a transaction and
// proves as postgres, anon, an owner and a technician that
//
//   * every event fires on its transition and on nothing else: an edit of a
//     completed visit, a draft invoice opening, a pending payment, a quote
//     being sent, a lead with no organization — none of them emit;
//   * one event reaches every subscribed, enabled endpoint of its own
//     organization with one event id, and no other tenant's;
//   * no payload carries an email, phone, address, gate code, note, free-text
//     reason, token, checkout link, Stripe id or card detail, checked against
//     marker strings planted in exactly those columns;
//   * an outbox that refuses the insert costs a WARNING and not the write;
//   * claims lease rows once, retries land on the schedule given, the fifth
//     failed delivery switches the endpoint off and reports it once, a test
//     delivery never counts, switching back on starts clean;
//   * anon reaches nothing; the owner can read and edit their own endpoints
//     but cannot create one, move one's URL, read a secret, write the outbox
//     or claim; a technician sees nothing;
//
// and then ROLLS BACK, the migration included.
//
// When no database is reachable it says so loudly and skips, because "the
// proof passed" and "no proof ran" must not read the same.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WEBHOOK_EVENT_TYPES } from "@/lib/webhooks";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION_FILE = "20260929080000_nothing-could-listen-for-a-completed-visit.sql";
const MIGRATION = join(ROOT, "supabase/migrations", MIGRATION_FILE);
const PROOF = join(ROOT, "tests/sql/nothing-could-listen-for-a-completed-visit.proof.sql");
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

const raw = readFileSync(MIGRATION, "utf8");
/** The migration with `--` comments removed, so prose cannot satisfy a check. */
const sql = raw.replace(/^\s*--.*$/gm, "").replace(/--[^\n]*/g, "");

/** The body of one CREATE FUNCTION, up to its closing $fn$. */
function fnBody(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not created`).toBeGreaterThan(-1);
  const open = sql.indexOf("$fn$", start);
  const close = sql.indexOf("$fn$", open + 4);
  return sql.slice(start, close);
}

/** Every CREATE TRIGGER statement, by name. */
function triggers(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sql.matchAll(/CREATE TRIGGER (\w+)([\s\S]*?);/g))
    out.set(m[1], m[2].replace(/\s+/g, " ").trim());
  return out;
}

describe("the event list", () => {
  it("is the same nine names in the code and in both CHECK constraints", () => {
    expect([...WEBHOOK_EVENT_TYPES].sort()).toEqual(
      [
        "client.created",
        "invoice.created",
        "invoice.paid",
        "lead.created",
        "payment.received",
        "quote.accepted",
        "quote.declined",
        "visit.completed",
        "visit.skipped",
      ].sort(),
    );
    const endpointCheck =
      /webhook_endpoints_events_known CHECK \(\s*events <@ ARRAY\[([\s\S]*?)\]/.exec(sql)![1];
    const deliveryCheck =
      /webhook_deliveries_event_type_check CHECK \(\s*event_type IN \(([\s\S]*?)\)/.exec(sql)![1];
    const names = (s: string) => [...s.matchAll(/'([a-z.]+)'/g)].map((m) => m[1]).sort();
    expect(names(endpointCheck)).toEqual([...WEBHOOK_EVENT_TYPES].sort());
    expect(names(deliveryCheck)).toEqual([...WEBHOOK_EVENT_TYPES, "webhook.test"].sort());
  });
});

describe("each trigger fires on its transition, and only on it", () => {
  const t = triggers();

  it("client.created and lead.created fire on INSERT only", () => {
    expect(t.get("webhook_emit_client")).toMatch(
      /^AFTER INSERT ON public\.clients FOR EACH ROW EXECUTE/,
    );
    expect(t.get("webhook_emit_lead")).toMatch(
      /^AFTER INSERT ON public\.leads FOR EACH ROW WHEN \(NEW\.organization_id IS NOT NULL\)/,
    );
  });

  it("visits fire on the move TO completed or skipped, not on every update", () => {
    expect(t.get("webhook_emit_visit")).toBe(
      "AFTER UPDATE ON public.visits FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed'::public.visit_status, 'skipped'::public.visit_status)) EXECUTE FUNCTION public.webhook_emit_visit()",
    );
    // And the function re-checks, so attaching it anywhere else is harmless.
    expect(fnBody("webhook_emit_visit")).toMatch(
      /IF TG_OP <> 'UPDATE' OR OLD\.status IS NOT DISTINCT FROM NEW\.status THEN\s+RETURN NULL;/,
    );
  });

  it("invoices: created on insert, paid on the move to paid", () => {
    expect(t.get("webhook_emit_invoice_insert")).toMatch(
      /^AFTER INSERT ON public\.invoices FOR EACH ROW EXECUTE/,
    );
    expect(t.get("webhook_emit_invoice_paid")).toBe(
      "AFTER UPDATE ON public.invoices FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'paid'::public.invoice_status) EXECUTE FUNCTION public.webhook_emit_invoice()",
    );
  });

  it("payments: on a succeeded insert or the move to succeeded", () => {
    expect(t.get("webhook_emit_payment_insert")).toMatch(
      /^AFTER INSERT ON public\.payments FOR EACH ROW WHEN \(NEW\.status = 'succeeded'::public\.payment_status\)/,
    );
    expect(t.get("webhook_emit_payment_succeeded")).toMatch(
      /^AFTER UPDATE ON public\.payments FOR EACH ROW WHEN \(OLD\.status IS DISTINCT FROM NEW\.status AND NEW\.status = 'succeeded'::public\.payment_status\)/,
    );
  });

  it("quotes: on the move to accepted or declined", () => {
    expect(t.get("webhook_emit_quote")).toMatch(
      /^AFTER UPDATE ON public\.quotes FOR EACH ROW WHEN \(OLD\.status IS DISTINCT FROM NEW\.status AND NEW\.status IN \('accepted', 'declined'\)\)/,
    );
  });

  it("never uses UPDATE OF, which misses a status moved by another trigger", () => {
    for (const [name, def] of t) expect(def, name).not.toMatch(/UPDATE OF/);
  });
});

describe("payloads are small and carry nothing sensitive", () => {
  const EMITTERS = [
    "webhook_emit_client",
    "webhook_emit_visit",
    "webhook_emit_invoice",
    "webhook_emit_payment",
    "webhook_emit_quote",
    "webhook_emit_lead",
  ];
  /** Column names that must never be read into a payload. */
  const SENSITIVE =
    /NEW\.(primary_email|primary_phone|email|phone|prospect_email|prospect_phone|notes|message|location|tech_note|gate_reply|gate_code|access_notes|skip_reason\b|decline_reason|portal_token|public_token|checkout_url|stripe_\w+|raw_event|reference|default_card_\w+|default_payment_method_id|sms_consent_\w+|completion_photo_waived_reason)/;
  const SENSITIVE_KEYS =
    /'(email|phone|address|street|gate\w*|notes?|message|token|secret|password|card\w*|last4|stripe\w*|checkout\w*|raw_event|reference|reason)'/;

  for (const fn of EMITTERS) {
    it(`${fn} reads no sensitive column and names no sensitive key`, () => {
      const body = fnBody(fn);
      expect(body).toMatch(/jsonb_build_object\(/);
      expect(body).not.toMatch(SENSITIVE);
      const keys = [...body.matchAll(/'([a-z_]+)',\s*(?:NEW\.|\(|_|COALESCE)/g)].map((m) => m[1]);
      expect(keys.length, `${fn}: no payload keys parsed`).toBeGreaterThan(3);
      for (const k of keys) expect(`'${k}'`, `${fn} sends ${k}`).not.toMatch(SENSITIVE_KEYS);
    });
  }

  it("builds the envelope the docs promise: id, type, created_at, organization_id, data", () => {
    const enqueue = fnBody("webhook_enqueue");
    for (const k of ["id", "type", "created_at", "organization_id", "data"]) {
      expect(enqueue).toMatch(new RegExp(`'${k}',`));
    }
  });
});

describe("the tables", () => {
  it("have RLS on, and give anon nothing", () => {
    for (const t of ["webhook_endpoints", "webhook_endpoint_secrets", "webhook_deliveries"]) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON public\\.${t} FROM PUBLIC, anon, authenticated`),
      );
      expect(sql).not.toMatch(new RegExp(`GRANT[^;]*ON public\\.${t} TO[^;]*\\banon\\b`));
    }
  });

  it("scope every policy to the organization and manage_settings", () => {
    const policies = [
      ...sql.matchAll(/CREATE POLICY "[^"]+" ON public\.(webhook_\w+)([\s\S]*?);/g),
    ];
    expect(policies.length).toBe(4);
    for (const [, table, body] of policies) {
      expect(table).not.toBe("webhook_endpoint_secrets");
      expect(body).toMatch(/TO authenticated/);
      expect(body).toMatch(
        /has_permission\(\(SELECT auth\.uid\(\)\), organization_id, 'manage_settings'\)/,
      );
    }
  });

  it("let the office edit only description, events and the switch", () => {
    expect(sql).toMatch(/GRANT SELECT, DELETE ON public\.webhook_endpoints TO authenticated;/);
    expect(sql).toMatch(
      /GRANT UPDATE \(description, events, enabled\) ON public\.webhook_endpoints TO authenticated;/,
    );
    expect(sql).toMatch(/GRANT SELECT ON public\.webhook_deliveries TO authenticated;/);
  });

  it("index every foreign key and the worker's (status, next_attempt_at)", () => {
    expect(sql).toMatch(/ON public\.webhook_deliveries \(status, next_attempt_at\)/);
    expect(sql).toMatch(/ON public\.webhook_deliveries \(organization_id\)/);
    expect(sql).toMatch(/ON public\.webhook_deliveries \(endpoint_id, created_at DESC\)/);
    expect(sql).toMatch(/ON public\.webhook_endpoints \(organization_id\)/);
    expect(sql).toMatch(/ON public\.webhook_endpoints \(created_by\)/);
    // webhook_endpoint_secrets.endpoint_id is its primary key.
    expect(sql).toMatch(/endpoint_id uuid PRIMARY KEY REFERENCES public\.webhook_endpoints\(id\)/);
  });

  it("refuse a plaintext secret and an http URL in the database itself", () => {
    expect(sql).toMatch(
      /CONSTRAINT webhook_endpoint_secrets_encrypted CHECK \(secret_ciphertext ~ '\^v1\\\./,
    );
    expect(sql).toMatch(/CONSTRAINT webhook_endpoints_url_is_https CHECK \(url ~ '\^https:\/\//);
  });
});

describe("the functions follow the trigger-function rules", () => {
  const FNS = [
    "webhook_endpoints_before_update",
    "webhook_emit_client",
    "webhook_emit_visit",
    "webhook_emit_invoice",
    "webhook_emit_payment",
    "webhook_emit_quote",
    "webhook_emit_lead",
    "webhook_enqueue",
    "webhook_claim_deliveries",
    "webhook_record_attempt",
    "webhook_prune_deliveries",
  ];
  for (const fn of FNS) {
    it(`${fn} has a fixed search_path and is revoked from the API roles`, () => {
      expect(fnBody(fn)).toMatch(/SET search_path TO 'public', 'pg_temp'/);
      expect(sql).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`,
        ),
      );
      expect(sql).not.toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO [^;]*(anon|authenticated)`,
        ),
      );
    });
  }

  it("keeps the enqueue from ever failing the write it rides on", () => {
    for (const fn of [
      "webhook_emit_client",
      "webhook_emit_visit",
      "webhook_emit_invoice",
      "webhook_emit_payment",
      "webhook_emit_quote",
      "webhook_emit_lead",
    ]) {
      expect(fnBody(fn), fn).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING/);
    }
  });
});

describe("the worker is scheduled and wired", () => {
  it("runs every minute against the canonical host, only when something is due", () => {
    const sched =
      /cron\.schedule\('deliver-webhooks', '\* \* \* \* \*', \$job\$([\s\S]*?)\$job\$\)/.exec(sql);
    expect(sched, "deliver-webhooks is not scheduled").not.toBeNull();
    const cmd = sched![1];
    expect(cmd).toMatch(
      /url := 'https:\/\/app\.houndstack\.com\/api\/public\/hooks\/webhook-deliveries'/,
    );
    expect(cmd).toMatch(
      /FROM vault\.decrypted_secrets s\s+WHERE s\.name = 'cron_service_role_key'/,
    );
    expect(cmd).toMatch(/d\.status = 'pending' AND d\.next_attempt_at <= now\(\) AND e\.enabled/);
    expect(cmd).toMatch(/timeout_milliseconds := 60000/);
    expect(cmd).toMatch(/SELECT public\.webhook_prune_deliveries\(\);/);
  });

  it("only WARNS about its own cron job, which the-wiring-is-connected requires", () => {
    const cronCheck = sql.slice(sql.indexOf("DO $cron$"));
    expect(cronCheck).toMatch(/RAISE WARNING 'deliver-webhooks is not scheduled/);
    expect(cronCheck).not.toMatch(/RAISE EXCEPTION/);
  });

  it("has a route that enforces the cron credential", () => {
    const route = readFileSync(
      join(ROOT, "src/routes/api/public/hooks/webhook-deliveries.ts"),
      "utf8",
    );
    expect(route).toMatch(
      /const auth = authorizeCronRequest\(request\);\s+if \(!auth\.ok\) return cronUnauthorized\(/,
    );
    expect(route).toMatch(/processWebhookDeliveries\(/);
  });

  it("encrypts the secret at both write sites", () => {
    const fns = readFileSync(join(ROOT, "src/lib/webhooks.functions.ts"), "utf8");
    const writes = [
      ...fns.matchAll(
        /\.from\("webhook_endpoint_secrets"\)\s*\.(insert|upsert)\(\s*\{([\s\S]*?)\}/g,
      ),
    ];
    expect(writes.length).toBe(2);
    for (const w of writes) expect(w[2]).toMatch(/secret_ciphertext: encryptSecret\(secret\)/);
  });

  it("checks the destination at save time and when switching back on", () => {
    const fns = readFileSync(join(ROOT, "src/lib/webhooks.functions.ts"), "utf8");
    expect(fns.match(/await checkWebhookDestination\(/g)?.length).toBe(2);
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
    `\n  SKIPPED: the webhook proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("the webhook rules hold in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 120_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Twelve groups of checks, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(12);
    expect(out).toMatch(/ALL WEBHOOK PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Webhook Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
