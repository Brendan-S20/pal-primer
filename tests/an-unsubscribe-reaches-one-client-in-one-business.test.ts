// An unsubscribe reaches one client in one business.
//
// Every campaign email ends in an unsubscribe link, because CAN-SPAM requires
// one that works. The product already had one: /unsubscribe, backed by
// email_unsubscribe_tokens. It is reused, page and endpoint both, but its
// token could not be: that table is UNIQUE(email) with no organization, and
// redeeming a row writes the global suppressed_emails list, so a customer
// leaving one business's spring promotion would have stopped every invoice
// from every business on the platform that serves them.
//
// A campaign's link is a client_unsubscribe_tokens row instead, and redeeming
// it sets clients.email_opt_out on the one client, in the one organization,
// it was minted for.
//
// The rules are proved in a real Postgres by
// tests/sql/nobody-could-send-a-seasonal-offer.proof.sql, which applies the
// migration inside a transaction, builds two businesses sharing a customer,
// and ROLLS BACK. When no database is reachable it says so loudly and skips:
// "the experiment passed" and "no experiment ran" must not read the same.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const DB_URL =
  process.env.CAMPAIGNS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20260929070000_nobody-could-send-a-seasonal-offer.sql",
);
const PROOF = join(ROOT, "tests/sql/nobody-could-send-a-seasonal-offer.proof.sql");

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
    `\n  SKIPPED: the campaign proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set CAMPAIGNS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("the campaign rules hold in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Ten groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(10);
    expect(out).toMatch(
      /ok: an unsubscribe opts out exactly one client in exactly one business, once/,
    );
    expect(out).toMatch(/ALL CAMPAIGN PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Campaign Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});

describe("the link in the email is the scoped one", () => {
  const enqueue = read("src/lib/email/enqueue.server.ts");

  it("minted per client and organization, before the template renders", () => {
    const mintAt = enqueue.indexOf('.from("client_unsubscribe_tokens")');
    const renderAt = enqueue.indexOf("html = await render(element);");
    expect(mintAt).toBeGreaterThan(-1);
    expect(mintAt).toBeLessThan(renderAt);
    expect(enqueue).toMatch(/organization_id: params\.organizationId, client_id: client\.id/);
    expect(enqueue).toMatch(/\.eq\("organization_id", params\.organizationId\)/);
  });

  it("merged AFTER the caller's data, so no caller can supply its own", () => {
    const merged = enqueue.slice(enqueue.indexOf("const mergedData = {"));
    const body = merged.slice(0, merged.indexOf("};"));
    expect(body.indexOf("unsubscribeUrl")).toBeGreaterThan(body.indexOf("...params.templateData"));
  });

  it("no link, no email", () => {
    // A campaign only: since one-click was fixed for every email, an invoice
    // whose client token cannot be minted falls back rather than going unsent.
    expect(enqueue).toMatch(
      /if \(!tok\?\.token && params\.clientUnsubscribe\) return \{ ok: false, reason: "enqueue_failed" \};/,
    );
  });

  it("and the global, address-wide token is not minted for it", () => {
    const tokenBlock = enqueue.slice(enqueue.indexOf("let unsubscribeToken: string;"));
    expect(tokenBlock.slice(0, 400)).toMatch(
      /if \(clientUnsubscribeToken\) \{\s+unsubscribeToken = clientUnsubscribeToken;\s+\} else \{/,
    );
  });

  it("every campaign email asks for it", () => {
    expect(read("src/lib/campaigns.server.ts")).toMatch(/clientUnsubscribe: true,/);
    expect(read("src/lib/email-templates/campaign.tsx")).toMatch(/<Link href=\{unsubscribeUrl\}/);
  });
});

describe("the endpoint answers both kinds of token", () => {
  const route = read("src/routes/email/unsubscribe.ts");

  it("redeems a campaign token through the scoped function, never the suppression list", () => {
    const post = route.slice(route.indexOf("POST: async"));
    const clientBranch = post.slice(
      post.indexOf('"redeem_client_unsubscribe_token"'),
      post.indexOf("if (tokenRecord.used_at)"),
    );
    expect(clientBranch.length).toBeGreaterThan(0);
    expect(clientBranch).not.toMatch(/suppressed_emails/);
    expect(clientBranch).toMatch(/return Response\.json\(\{ success: true \}\);/);
  });

  it("tells the page whether a campaign token is live, used, or unknown", () => {
    const get = route.slice(route.indexOf("GET: async"), route.indexOf("POST: async"));
    expect(get).toMatch(/"client_unsubscribe_token_state"/);
    expect(get).toMatch(/case "ready":\s+return Response\.json\(\{ valid: true \}\);/);
    expect(get).toMatch(
      /case "already":\s+return Response\.json\(\{ valid: false, reason: "already_unsubscribed" \}\);/,
    );
  });

  it("one-click works for a campaign, and a browser lands on the page", () => {
    // RFC 8058: the mail client POSTs to the List-Unsubscribe URL. The page
    // route answers a POST with 200 and HTML and unsubscribes nobody, so a
    // campaign's header points at this endpoint, which also sends a browser
    // that opened the link on to the page.
    expect(read("src/lib/email/enqueue.server.ts")).toMatch(
      /unsubscribe_url: appUrl\(`\/email\/unsubscribe\?token=\$\{unsubscribeToken\}`\)/,
    );
    expect(read("src/routes/email/queue/process.ts")).toMatch(/payload\.unsubscribe_url/);
    const get = route.slice(route.indexOf("GET: async"), route.indexOf("POST: async"));
    expect(get).toMatch(/includes\("text\/html"\)/);
    expect(get).toMatch(/Location: `\/unsubscribe\?token=\$\{encodeURIComponent\(token\)\}`/);
  });
});
