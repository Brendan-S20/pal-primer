// Two ways to be stuck, reported together.
//
// ── THE LEGAL PAGES ──────────────────────────────────────────────────────
//
// "I clicked on privacy policy at the bottom, and it isn't optimized on my
// device to go back to sign-in."
//
// There WAS a way back: a 14px "Sign in" link in the top right. With no
// safe-area inset it sat under the status bar on a phone, and 14px of text is
// not a touch target. These pages are reachable from the sign-in card, so a
// person who taps Privacy Policy while signing up has to be able to come back.
//
// ── AND THE LOCKOUT ──────────────────────────────────────────────────────
//
// "There should also be a way to link and de-link oAuth in settings, this way
// if they lose access to say their facebook account, it's still tied to an
// email or phone."
//
// Right, and it is the more serious of the two: somebody who signed up with
// Facebook and loses that account has no door left. The data is all still
// there and nobody can reach it without a manual identity edit.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const shell = read("src/components/LegalShell.tsx");
const card = read("src/components/SignInMethodsCard.tsx");
const profile = read("src/routes/_authenticated/profile.tsx");

describe("a legal page is not a dead end on a phone", () => {
  it("uses the same safe-area treatment as the app's own top bar", () => {
    // Consistency was the actual request. paddingTop inline because nothing
    // sets py here; horizontal insets in the className so they EXTEND the
    // padding rather than replace it -- the scar recorded in native-build.ts.
    expect(shell).toMatch(/nativeTopBarStyle\(\)/);
    expect(shell).toMatch(/pl-\[calc\(1rem\+env\(safe-area-inset-left\)\)\]/);
  });

  it("the back control is a 44px target, not a line of text", () => {
    expect(shell).toMatch(/min-h-11/);
    expect(shell).toMatch(/ChevronLeft/);
  });

  it("goes back where there is history, and to sign-in where there is not", () => {
    // Twilio's verification reviewers and carriers open these cold. A Back
    // button with nothing behind it is the same dead end in a new coat.
    expect(shell).toMatch(/useCanGoBack/);
    expect(shell).toMatch(/router\.history\.back\(\)/);
    expect(shell).toMatch(/to="\/auth"/);
  });

  it("leaves room at the bottom for the home indicator", () => {
    expect(shell).toMatch(/env\(safe-area-inset-bottom\)/);
  });
});

describe("you cannot remove your last way in", () => {
  it("is reachable from the account page", () => {
    expect(profile).toMatch(/<SignInMethodsCard \/>/);
  });

  it("disables the last remaining identity rather than letting it fail", () => {
    // Supabase refuses the final identity server-side too, but its refusal
    // arrives as a generic error AFTER the tap, which reads as a bug. The
    // answer belongs on the button, before the attempt.
    expect(card).toMatch(/const isLast = connected && ways <= 1/);
    expect(card).toMatch(/disabled=\{isLast \|\| busy\}/);
    expect(card).toMatch(/Only way in/);
  });

  it("never offers to unlink email", () => {
    // Email is the recovery route that still works when a PROVIDER is the
    // thing that has gone wrong, which is the whole scenario this card is for.
    const emailBlock = card.slice(card.indexOf('i.provider === "email"'));
    expect(emailBlock.slice(0, 900)).not.toMatch(/unlink\.mutate/);
    expect(card).toMatch(/Always available/);
  });

  it("links through the system browser on native, like signing in does", () => {
    // linkIdentity redirects exactly as signInWithOAuth does, so it hits the
    // same embedded-WebView refusal from Google if it is not sent outside.
    expect(card).toMatch(/IS_NATIVE_BUNDLE/);
    expect(card).toMatch(/skipBrowserRedirect: true/);
    expect(card).toMatch(/@capacitor\/browser/);
  });

  it("names the Supabase setting when linking is switched off", () => {
    // "Manual linking is not enabled" is not something a user can act on.
    expect(card).toMatch(/Manual Linking/);
  });
});
