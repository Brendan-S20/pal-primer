import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Deleting an account has a database half that must succeed, and three steps
// after it that are best effort: cancel the workspace subscription, anonymise
// the auth identity, revoke every session.
//
// Best effort is right and does not change. The database half has already
// committed by then, and a Stripe outage or a GoTrue hiccup must not leave
// somebody unable to delete their account -- an un-deletable account is worse
// than a recoverable loose end.
//
// What was wrong is that all three swallowed their failure and the function
// returned `ok: true` regardless, so the screen said "Your account is deleted"
// whether or not the address had been detached and whether or not other
// devices were still signed in. The three are not equally serious and none is
// cosmetic:
//
//   identity  the address is still on the account, can still receive a
//             password reset, and still blocks a genuine re-signup.
//   sessions  every signed-in device stays signed in -- so a deletion done
//             BECAUSE a laptop was lost achieves nothing.
//   billing   a closed workspace keeps its subscription and we keep taking
//             money from somebody who closed their account.

const FN = readFileSync(join(process.cwd(), "src/lib/delete-account.functions.ts"), "utf8");
const CARD = readFileSync(join(process.cwd(), "src/components/DeleteAccountCard.tsx"), "utf8");

/** Comments stripped, so prose about a step cannot satisfy a check for it. */
const code = FN.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("the steps that did not happen are named", () => {
  it("records each of the three", () => {
    for (const step of ["billing", "identity", "sessions"]) {
      expect(code, `nothing records a failed ${step} step`).toMatch(
        new RegExp(`incomplete\\.push\\("${step}"\\)`),
      );
    }
  });

  it("returns them to the caller", () => {
    expect(code).toMatch(/return \{[\s\S]*incomplete,[\s\S]*\}/);
  });

  it("pushes from inside a catch, not from a success path", () => {
    // The mutation this guards: recording the step unconditionally, which
    // would warn on every clean deletion.
    for (const step of ["billing", "identity", "sessions"]) {
      const i = code.indexOf(`incomplete.push("${step}")`);
      expect(i).toBeGreaterThan(-1);
      expect(code.slice(Math.max(0, i - 200), i)).toMatch(/catch\s*\(/);
    }
  });

  it("still reports ok, because the irreversible half did succeed", () => {
    // Turning a failed session revoke into a thrown error would tell somebody
    // their deletion failed when the part that cannot be undone worked, and
    // would invite them to press the button again.
    expect(code).toMatch(/ok: true as const/);
    const tail = code.slice(code.indexOf("const incomplete"));
    expect(tail.slice(0, tail.indexOf("return {"))).not.toMatch(/\bthrow\b/);
  });
});

describe("and the screen stops claiming a clean deletion", () => {
  it("does not redirect when something is outstanding", () => {
    // The redirect to /auth exists BECAUSE every session was revoked. When the
    // revoke is one of the failures, its premise is false and the person is
    // still signed in. Navigating would also throw away the only telling they
    // get: a toast fired immediately before window.location.href is never read.
    const onSuccess = CARD.slice(CARD.indexOf("onSuccess: (r: any)"));
    const body = onSuccess.slice(0, onSuccess.indexOf("onError:"));
    const guard = body.indexOf("if (left.length)");
    const redirect = body.indexOf('window.location.href = "/auth"');
    expect(guard).toBeGreaterThan(-1);
    expect(redirect).toBeGreaterThan(guard);
    // The early return is what keeps the redirect out of reach.
    expect(body.slice(guard, redirect)).toMatch(/return;/);
  });

  it("does not call it a success", () => {
    const onSuccess = CARD.slice(CARD.indexOf("onSuccess: (r: any)"));
    const body = onSuccess.slice(0, onSuccess.indexOf("onError:"));
    const guard = body.indexOf("if (left.length)");
    expect(body.slice(guard, body.indexOf("return;", guard))).not.toMatch(/toast\.success/);
  });

  it("has words for every step, checked by the type rather than by hand", () => {
    // A Record keyed on DeletionStep, so a fourth step fails to compile until
    // somebody writes what it means to a person.
    expect(CARD).toMatch(/const DELETION_STEP_NOTE: Record<DeletionStep, string>/);
    for (const step of ["identity", "sessions", "billing"]) {
      expect(CARD).toMatch(new RegExp(`\\b${step}:\\s*\\n?\\s*"`));
    }
  });

  it("says what each one lets somebody still do, not what our log calls it", () => {
    // "Anonymisation failed" is a sentence for us. What they need is that a
    // password reset could still reach the address.
    expect(CARD).toMatch(/password reset could still be sent/);
    expect(CARD).toMatch(/may still be signed in/);
    expect(CARD).toMatch(/billing may continue/);
  });

  it("counts the outstanding steps rather than asserting a number", () => {
    // It was "Two things are not done." while the list is one, two or three.
    expect(CARD).not.toMatch(/Two things are not done/);
    expect(CARD).toMatch(/incomplete\.length === 1/);
  });

  it("tells them not to press delete again", () => {
    // The instinct on "not finished" is to retry. The records are already gone
    // and retrying clears none of these.
    expect(CARD).toMatch(/Do not press delete\s*\n?\s*again/);
  });

  it("still says the deletion itself is not reversible", () => {
    // The warning must not read as "it did not work", which would be its own
    // false statement in the other direction.
    expect(CARD).toMatch(/is not reversible/);
  });
});
