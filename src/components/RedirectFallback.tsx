import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

// QA-P2 — what a pure-redirect route renders if it ever renders at all.
//
// `/settings/payments` is a stub: `beforeLoad` throws a redirect to
// `/payments` and there is nothing else to it. On roughly one cold load in
// four it produced a BLANK page — the URL rewrote to /payments, the main area
// held zero characters, and the console carried an unhandled `undefined` plus
// React's "An error occurred in the <MatchInnerImpl> component".
//
// The happy path never renders this. `beforeLoad` throws before any component
// is reached, which is exactly why five of these stubs were written with no
// component at all — including this one. A route with no component gets the
// router's default, which renders an `<Outlet />`; on a LEAF route that Outlet
// has nothing under it, so the page is empty by construction the moment
// anything causes the match to render instead of redirect.
//
// ── WHAT THIS DOES AND DOES NOT CLAIM ─────────────────────────────────────
//
// It does not claim to have found the race. The symptom was intermittent, seen
// on a dev server, and could not be reproduced here — this environment has no
// browser harness and the failure is a timing interaction between the parent
// `_authenticated` guard and the redirect throw. Guessing at that mechanism
// and shipping a change that "should" fix it is how a plausible edit gets
// mistaken for a fix.
//
// What it does is make the SYMPTOM impossible, and recover:
//
//   * if the route renders, there is something to look at instead of nothing;
//   * the navigation is retried from the client, so a redirect that did not
//     happen during load still happens — a dead end becomes self-healing;
//   * the error came from rendering a match with no component, so there is no
//     longer a match with no component.
//
// Two of the codebase's redirect stubs already had a component
// (`platform.index` used `() => null`, `portal.$slug` an `<Outlet />`) and
// neither was reported blank. The pattern existed; it just was not applied
// to the five that mattered. `() => null` would silence the error and still
// leave a blank page, which is why this renders and retries instead.
//
// ── WHY IT MATTERS MORE THAN A RARE BLANK PAGE ────────────────────────────
//
// This stub exists specifically to catch Stripe Connect onboarding return and
// refresh URLs. So the one-in-four lands on someone coming back from Stripe
// mid-onboarding, at the moment they are being asked to trust us with their
// payouts, and it lands as a white screen with no message and no way forward.

export function RedirectFallback({
  to,
  label,
}: {
  /** Where this route is an alias for. */
  to: string;
  /** What the destination is called, in the sentence shown to the person. */
  label: string;
}) {
  const navigate = useNavigate();

  useEffect(() => {
    // `replace` so the alias does not become a back-button trap between the
    // two URLs.
    void navigate({ to, replace: true, search: (s: Record<string, unknown>) => s });
  }, [navigate, to]);

  return (
    <div className="flex min-h-[40vh] items-center justify-center p-8">
      <p className="text-sm text-muted-foreground">
        Taking you to {label}…{" "}
        <a href={to} className="underline underline-offset-4">
          Continue
        </a>
      </p>
    </div>
  );
}
