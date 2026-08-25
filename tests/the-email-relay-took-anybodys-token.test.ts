// /email/transactional/send validated a user's JWT and then never used it.
//
// `user` appeared exactly twice in the file: once destructured out of
// getUser(token), once null-checked. No org lookup, no role check, no ownership
// check on the recipient — and the Supabase client is built with the SERVICE
// ROLE key, so the send log and enqueue bypass RLS.
//
// So any signed-in user of any tenant could send HoundStack-branded HTML from
// noreply@notify.houndstack.com, SPF/DKIM aligned, to any address, with
// attacker-controlled templateData.
//
// It is locked to the service role now rather than given per-org checks,
// because nothing calls it: the live `process-email-queue` cron posts to
// /email/queue/process, a different route. These tests hold that shape.
//
// Deliberately a source scan rather than a request test. The fault was not a
// behaviour that a fixture would exercise — it was a value being computed and
// discarded, which reads as correct in every log and every response.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const send = readFileSync(join(root, "src/routes/email/transactional/send.ts"), "utf8");
const queue = readFileSync(join(root, "src/routes/email/queue/process.ts"), "utf8");

describe("the transactional email relay is internal-only", () => {
  it("compares the bearer token against the service role key", () => {
    expect(send).toMatch(/token !== supabaseServiceKey/);
    expect(send).toMatch(/status: 403/);
  });

  it("does not authenticate a USER token, which is the whole fault", () => {
    // getUser(token) here means any tenant's signed-in user is admitted again.
    expect(send).not.toMatch(/auth\.getUser\(/);
  });

  it("matches the sibling route that cron actually drives", () => {
    // /email/queue/process has had this right since it was written. If these
    // two ever disagree about what authorizes an internal email endpoint, one
    // of them is wrong and this says so.
    expect(queue).toMatch(/token !== supabaseServiceKey/);
  });

  it("still refuses a request with no bearer token at all", () => {
    expect(send).toMatch(/authHeader\?\.startsWith\("Bearer "\)/);
    expect(send).toMatch(/status: 401/);
  });
});
