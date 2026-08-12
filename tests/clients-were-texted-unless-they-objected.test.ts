// Twilio rejected toll-free verification with 30513, "Opt-in — Consent for
// messaging is a requirement for service".
//
// The submission could not describe an opt-in because there was not one.
// `organizations` had real consent columns (at / phone / verbatim text) for the
// TENANT agreeing to hear from HoundStack. `clients` had `sms_opt_out` — a
// boolean defaulting to false, only ever set true AFTER somebody replied STOP.
// A client nobody had asked read as sendable. Consent was assumed and recorded
// only by its absence, so no rewording of the submission could have fixed it.
//
// Probed live as a real org owner (request.jwt.claims set, so can_write_org
// actually ran) on an unpaused client:
//   before any consent      -> false   (the state that was rejected)
//   after recording consent -> TRUE    (positive control)
//   consented then STOP     -> false
//   consented, comms paused -> false
//   same number reformatted -> TRUE    (formatting must not destroy consent)
//   different number        -> false, and the consent row cleared
//   timestamp with no wording -> rejected by the CHECK constraint
//   9-character wording     -> rejected by the function
//
// The first run of that probe returned false for the positive control and
// looked like a bug in the guard. It was not: the client it happened to pick
// had `comms_paused = true`, which is a legitimate separate block. The probe
// was missing a control for it. That is why the subject line now pins
// comms_paused = false — a guard that refuses everything and a guard that
// works are indistinguishable without one.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dir = join(root, "supabase/migrations");
const SQL = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .join("\n");

function lastBody(name: string) {
  const at = SQL.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(at, `${name} is not defined`).toBeGreaterThan(-1);
  const end = SQL.indexOf("$$;", SQL.indexOf("AS $$", at));
  return SQL.slice(at, end === -1 ? undefined : end);
}
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("consent is a recorded fact, not an absent refusal", () => {
  it("stores when, for which number, in whose words, and how", () => {
    for (const col of [
      "sms_consent_at",
      "sms_consent_phone",
      "sms_consent_text",
      "sms_consent_source",
    ]) {
      expect(SQL).toContain(col);
    }
  });

  it("refuses a timestamp with no evidence attached", () => {
    // A bare timestamp is exactly what a carrier will not accept, so the table
    // will not hold one.
    expect(SQL).toMatch(/clients_sms_consent_complete[\s\S]*?sms_consent_at IS NULL/);
    expect(SQL).toMatch(/clients_sms_consent_complete[\s\S]*?sms_consent_text IS NOT NULL/);
  });

  it("rejects empty wording even though the constraint would pass", () => {
    // `sms_consent_text = ''` satisfies NOT NULL and proves nothing.
    expect(lastBody("record_client_sms_consent")).toMatch(/length\(btrim\(_text\)\) < 10/);
  });

  it("never backfills existing clients", () => {
    // Inventing consent for rows already in the table would recreate the exact
    // fiction the carrier rejected, and would be worse for looking like proof.
    expect(SQL).not.toMatch(/UPDATE public\.clients\s+SET sms_consent_at = now\(\)\s*;/);
    expect(SQL).not.toMatch(
      /UPDATE public\.clients[\s\S]{0,200}sms_consent_at[\s\S]{0,120}WHERE sms_consent_at IS NULL/,
    );
  });
});

describe("the send guard", () => {
  it("treats no consent as no", () => {
    expect(lastBody("client_may_be_texted")).toMatch(/c\.sms_consent_at IS NOT NULL/);
  });

  it("lets STOP win over consent", () => {
    // Consented in March, replied STOP in June: refused.
    expect(lastBody("client_may_be_texted")).toMatch(/c\.sms_opt_out = false/);
  });

  it("requires the consent to be for the number currently on file", () => {
    // Numbers get recycled. Consent from the previous holder says nothing
    // about the person reachable there now, and texting them is the complaint
    // that gets a toll-free number shut off.
    expect(lastBody("client_may_be_texted")).toMatch(
      /phone_digits\(c\.primary_phone\)[\s\S]{0,80}phone_digits\(c\.sms_consent_phone\)/,
    );
  });

  it("compares digits, so reformatting a number does not destroy consent", () => {
    expect(lastBody("phone_digits")).toMatch(/regexp_replace/);
  });

  it("clears consent when the number actually changes", () => {
    const t = lastBody("tg_client_phone_change_clears_consent");
    expect(t).toMatch(/NEW\.sms_consent_at := NULL/);
    // But not when the same write is recording fresh consent for a new number,
    // which is the normal re-consent path.
    expect(t).toMatch(/NEW\.sms_consent_at IS NOT DISTINCT FROM OLD\.sms_consent_at/);
  });
});

describe("every sender asks the same question", () => {
  // The failure mode this is guarding: one path keeps checking `sms_opt_out`
  // alone and quietly becomes the source of all un-consented traffic.
  const senders = [
    "src/lib/messages.functions.ts",
    "src/lib/reviews.functions.ts",
    "src/lib/my-day.functions.ts",
  ];

  for (const f of senders) {
    it(`${f.split("/").pop()} gates on client_may_be_texted`, () => {
      expect(read(f)).toContain("client_may_be_texted");
    });
  }

  it("nobody decides sendability from sms_opt_out alone any more", () => {
    // reviews and my-day previously read `&& !c.sms_opt_out` as the whole test.
    for (const f of ["src/lib/reviews.functions.ts", "src/lib/my-day.functions.ts"]) {
      expect(read(f)).not.toMatch(/&&\s*!c(lient)?\.sms_opt_out\s*\)\s*\{/);
    }
  });
});

describe("the wording is one string", () => {
  it("is exported so the box, the evidence and the policy page cannot drift", () => {
    const c = read("src/lib/clients.functions.ts");
    expect(c).toMatch(/export const SMS_CONSENT_TEXT/);
    // The four things a carrier looks for in the disclosure.
    expect(c).toMatch(/not a condition of purchase/i);
    expect(c).toMatch(/Message and data rates may apply/i);
    expect(c).toMatch(/frequency varies/i);
    expect(c).toMatch(/Reply STOP to opt out/i);
  });

  it("the portal opt-in stores that same string", () => {
    const p = read("src/lib/portal.functions.ts");
    expect(p).toMatch(/SMS_CONSENT_TEXT/);
    expect(p).toMatch(/_source: "portal"/);
  });

  it("withdrawing consent keeps the record of what was agreed", () => {
    // Deleting the consent columns on opt-out would destroy the evidence for
    // every message already sent. sms_opt_out is the live switch; the consent
    // columns are history.
    const p = read("src/lib/portal.functions.ts");
    expect(p).toMatch(/update\(\{ sms_opt_out: true \}\)/);
    expect(p).not.toMatch(/sms_consent_at: null/);
  });
});
