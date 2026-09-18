// The no-provider branch is the ONLY branch anyone sees.
//
// On 2026-08-19 the owner decided not to configure an address provider yet.
// `getAddressProvider()` therefore returns null in production, and every
// address field in this app — six of them wired on the same day this file was
// written — runs the fallback path and nothing else. Whatever the happy path
// does, no customer will see it until somebody buys a key. So the fallback is
// not a courtesy branch to sanity-check; for now it is the product.
//
// Three ways it could be shipped broken, none of which any existing test or
// the type checker would notice, because all three are perfectly well-typed
// and only visible on a rendered page:
//
//   a dropdown that opens onto nothing,
//   a spinner that spins because no answer is ever coming,
//   a field you cannot simply type an address into.
//
// One of the three had already half-happened. The input carried
// `aria-expanded={open}` unconditionally — outside the `enabled` guard that
// governs the `role="combobox"` two lines above it. With no provider that is a
// plain text box which announces itself to a screen reader as a collapsed
// combobox: the popup it names does not exist and never will, and no sighted
// review of the page could have caught it.
//
// ── WHY THIS TESTS A FUNCTION AND NOT A RENDER ────────────────────────────
//
// `npm test` runs vitest in the default NODE environment; there is no jsdom in
// this repo (see the same note in
// a-map-that-ate-the-page-scroll-and-never-said-where-you-were.test.ts). The
// alternative to a pure function is asserting on the shape of the source text,
// which passes just as happily when the guard has been deleted, because the
// class list either way is identical. So AddressAutocomplete.tsx computes what
// it renders as a value, once, and this file asserts on the value.

import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach } from "vitest";
import { addressControlState } from "@/components/AddressAutocomplete";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every combination of the four provider-driven flags. The point of the
 *  fallback is that NONE of them can produce a popup, so it is worth trying
 *  all of them rather than the one a reviewer would think of. */
const COMBOS = [false, true].flatMap((open) =>
  [0, 3].flatMap((suggestionCount) =>
    [false, true].flatMap((searching) =>
      [false, true].map((resolving) => ({ open, suggestionCount, searching, resolving })),
    ),
  ),
);

describe("with no provider configured, an address field is a text field", () => {
  it("never renders a suggestion list, whatever the state says", () => {
    for (const c of COMBOS) {
      const ui = addressControlState({ enabled: false, ...c });
      expect(ui.listbox, `listbox with ${JSON.stringify(c)}`).toBe(false);
    }
  });

  it("never renders a spinner, because nothing is coming back", () => {
    for (const c of COMBOS) {
      const ui = addressControlState({ enabled: false, ...c });
      expect(ui.spinner, `spinner with ${JSON.stringify(c)}`).toBe(false);
    }
  });

  it("is not announced as a combobox, and does not claim a popup state", () => {
    // The half-shipped fault above. `role` was already guarded; `aria-expanded`
    // was not, so it rendered `false` — which is not "no popup", it is "there
    // is a popup and it is closed".
    for (const c of COMBOS) {
      const ui = addressControlState({ enabled: false, ...c });
      expect(ui.role, `role with ${JSON.stringify(c)}`).toBeUndefined();
      expect(ui.ariaExpanded, `aria-expanded with ${JSON.stringify(c)}`).toBeUndefined();
    }
  });

  it("is still an editable text input in every state", () => {
    for (const c of COMBOS) {
      expect(addressControlState({ enabled: false, ...c }).editable).toBe(true);
    }
  });
});

describe("with a provider, the same function still gates on real content", () => {
  it("opens the list only when there is something in it", () => {
    expect(
      addressControlState({
        enabled: true,
        open: true,
        suggestionCount: 0,
        searching: false,
        resolving: false,
      }).listbox,
    ).toBe(false);
    expect(
      addressControlState({
        enabled: true,
        open: true,
        suggestionCount: 2,
        searching: false,
        resolving: false,
      }).listbox,
    ).toBe(true);
  });

  it("shows the spinner while searching or while resolving a pick", () => {
    const base = { enabled: true, open: false, suggestionCount: 0 };
    expect(addressControlState({ ...base, searching: true, resolving: false }).spinner).toBe(true);
    expect(addressControlState({ ...base, searching: false, resolving: true }).spinner).toBe(true);
    expect(addressControlState({ ...base, searching: false, resolving: false }).spinner).toBe(
      false,
    );
  });

  it("announces the combobox and its open state", () => {
    const base = { enabled: true, suggestionCount: 1, searching: false, resolving: false };
    expect(addressControlState({ ...base, open: true }).role).toBe("combobox");
    expect(addressControlState({ ...base, open: true }).ariaExpanded).toBe(true);
    expect(addressControlState({ ...base, open: false }).ariaExpanded).toBe(false);
  });
});

describe("the registry and the provider degrade rather than fail", () => {
  beforeEach(() => {
    delete process.env.GOOGLE_PLACES_API_KEY;
  });

  it("hands back no provider when nothing is configured", async () => {
    const { getAddressProvider } = await import("@/lib/address/index.server");
    expect(getAddressProvider()).toBeNull();
  });

  it("answers empty rather than throwing if something calls it anyway", async () => {
    // A throw here would surface as a red toast on a form the owner never
    // turned this feature on for.
    const { googlePlacesProvider } = await import("@/lib/address/google-places.server");
    expect(googlePlacesProvider.isConfigured()).toBe(false);
    await expect(googlePlacesProvider.autocomplete("1600 Pennsylva")).resolves.toEqual([]);
    await expect(googlePlacesProvider.details("place-id")).resolves.toBeNull();
  });
});

describe("a keystroke with no provider costs nothing", () => {
  // Not style. `autocompleteAddress` is called on a 300ms debounce from every
  // address field in the app; if the `!provider` return moved below the rate
  // limiter and `resolveCaller`, a deployment with the feature switched OFF
  // would still run an auth lookup and a query per keystroke, for a result
  // that is empty by construction.
  const src = readFileSync(join(ROOT, "src/lib/address.functions.ts"), "utf8");
  const handler = src.slice(src.indexOf("export const autocompleteAddress"));

  it("returns before the rate limiter and the caller lookup", () => {
    const bail = handler.indexOf("if (!provider) return");
    const rate = handler.indexOf("checkRate(");
    const caller = handler.indexOf("resolveCaller(");
    expect(bail, "an early return for the no-provider case").toBeGreaterThan(-1);
    expect(bail, "the no-provider return must precede checkRate()").toBeLessThan(rate);
    expect(bail, "the no-provider return must precede resolveCaller()").toBeLessThan(caller);
  });

  it("does not retry the status probe three times per mounted form", () => {
    // react-query retries a rejected query three times with backoff by
    // default. The probe rejects outright wherever there is no staff session,
    // and answers a settled "no" everywhere else; neither is worth retrying,
    // and there is one of these per address field on the page.
    const ui = readFileSync(join(ROOT, "src/components/AddressAutocomplete.tsx"), "utf8");
    const query = ui.slice(ui.indexOf('queryKey: ["address-search-status"]'));
    expect(query.slice(0, 600)).toMatch(/retry:\s*false/);
  });
});
