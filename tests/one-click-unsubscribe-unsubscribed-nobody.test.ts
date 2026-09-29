// One-click unsubscribe unsubscribed nobody.
//
// Every email advertises RFC 8058 one-click unsubscribe (List-Unsubscribe plus
// List-Unsubscribe-Post), which is what puts Gmail's and Yahoo's "Unsubscribe"
// button next to the sender. For everything but campaigns the header pointed
// at the /unsubscribe PAGE, which answers the mail client's POST with 200 and
// HTML and unsubscribes nobody: the customer pressed Unsubscribe, kept
// getting mail, and the next step is the spam button.
//
// And the address-wide token behind it could not work past the first email:
// email_unsubscribe_tokens holds one row per address, the insert was bare, so
// from the second email on it failed silently and the header carried a token
// that did not exist.
//
// Now every email to a known client carries that client's own token (opt-out
// at this business only, never the platform-wide suppression list), the
// address-wide token is reused instead of re-inserted, and the header points
// at /email/unsubscribe, which answers the POST.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const code = (p: string) =>
  readFileSync(join(root, p), "utf8")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
const enqueue = code("src/lib/email/enqueue.server.ts");
const processor = code("src/routes/email/queue/process.ts");

describe("the header points at something that unsubscribes", () => {
  it("every queued email carries the one-click endpoint, not the page", () => {
    expect(enqueue).toMatch(
      /unsubscribe_url: appUrl\(`\/email\/unsubscribe\?token=\$\{unsubscribeToken\}`\)/,
    );
    // No longer conditional on being a campaign.
    expect(enqueue).not.toMatch(/\.\.\.\(clientUnsubscribeToken\s*\?\s*\{ unsubscribe_url/);
  });

  it("and so does the fallback for mail queued before this change", () => {
    const header = processor.slice(processor.indexOf("List-Unsubscribe") - 600);
    expect(header).toMatch(/appUrl\(`\/email\/unsubscribe\?token=/);
    expect(header).not.toMatch(/appUrl\(`\/unsubscribe\?token=/);
  });
});

describe("the token behind it exists", () => {
  it("mints or reuses a client-scoped token for any email to a known client", () => {
    expect(enqueue).toMatch(
      /if \(client\) \{\s*await supabaseAdmin\s*\.from\("client_unsubscribe_tokens"\)/,
    );
  });

  it("still refuses a campaign with no token, but lets an invoice fall back", () => {
    expect(enqueue).toMatch(/if \(!tok\?\.token && params\.clientUnsubscribe\) return/);
  });

  it("reuses the address-wide token instead of inserting a second one", () => {
    const addr = enqueue.slice(enqueue.indexOf('.from("email_unsubscribe_tokens")'));
    expect(addr).toMatch(/\.upsert\([\s\S]*?onConflict: "email", ignoreDuplicates: true/);
    expect(addr).toMatch(/\.select\("token"\)\s*\.eq\("email", recipient\)/);
    expect(enqueue).not.toMatch(/\.from\("email_unsubscribe_tokens"\)\s*\.insert\(/);
  });

  it("only puts the visible link in templates that print one", () => {
    expect(enqueue).toMatch(
      /clientUnsubscribeToken && params\.clientUnsubscribe\s*\?\s*\{ unsubscribeUrl/,
    );
  });
});
