// @vitest-environment happy-dom
//
// #946, from the Nov 16 2026 QA run of Setup step 2, "Your service area and
// price". Three faults, each pinned here:
//
//   1. The first-cleanup choice was required, but nothing said so until Save
//      refused with "Choose whether new clients pay for a first cleanup."
//      It now carries a Required marker from the start, with nothing picked
//      (either answer decides money), and the refusal stays as the backstop.
//   2. A business with a pinned address had no ZIP field: the step said
//      "Centered on your business address" and that was that, so the tester
//      typed "ZIP 48933" into the area's NAME. The ZIP field is always there,
//      prefilled from the business address; a ZIP typed centres the circle
//      there, and createZone fills the ZIPs the circle holds (#858).
//   3. On /clients/new, "Set a price per visit first." flashed while the zone
//      quote was still on its way, then the $20 arrived. It now waits for the
//      quote to answer with no price.

/* eslint-disable @typescript-eslint/no-explicit-any -- fakes of the Supabase client and createZone input, as the sibling setup-area test does */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({ data: validate(args?.data), context: { supabase: state.db, userId: "user-1" } }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org-1", role: "owner" }),
  requirePermission: async () => ({ orgId: "org-1", role: "owner" }),
}));
vi.mock("@/lib/zones-redetect.server", () => ({ redetectZonesForOrg: async () => 0 }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const SETUP = read("src/routes/_authenticated/setup.tsx");
const NEW_CLIENT = read("src/routes/_authenticated/clients.new.tsx");

const state = vi.hoisted(() => ({ db: null as any }));

const { SetupFirstCleanupChoice } = await import("@/components/SetupFirstCleanupChoice");
const { setupAreaCenter, setupAreaCenterProblem, setupAreaZipValue, zipFromAddress } =
  await import("@/lib/setup-area-center");
const { createClientPriceHint, CREATE_CLIENT_PRICE_HINT_COPY } =
  await import("@/lib/create-client-price-hint");
const { createZone } = await import("@/lib/zones.functions");

// ── 1. Required, before Save ─────────────────────────────────────────────────

let host: HTMLElement;
let root: Root | null = null;
async function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

describe("the first-cleanup choice is visibly required before Save", () => {
  const noop = () => {};

  it("shows Required, and picks nothing, on a fresh step", async () => {
    await render(
      <SetupFirstCleanupChoice
        tiered={false}
        value={null}
        onChange={noop}
        price=""
        onPriceChange={noop}
      />,
    );
    const legend = host.querySelector("fieldset[data-setup-first-cleanup] legend")!;
    expect(legend.textContent).toContain("First cleanup");
    expect(legend.querySelector("[data-setup-required]")?.textContent).toBe("Required");
    // No default: neither answer is pressed.
    const pressed = [...host.querySelectorAll("button[aria-pressed]")].map((b) =>
      b.getAttribute("aria-pressed"),
    );
    expect(pressed).toEqual(["false", "false"]);
    const hint = host.querySelector("[data-setup-first-cleanup-unchosen]")!;
    expect(hint.textContent).toMatch(/Choose one/);
    expect(
      host.querySelector("fieldset[data-setup-first-cleanup]")!.getAttribute("aria-describedby"),
    ).toBe(hint.id);
  });

  it("keeps the marker once chosen and drops the nudge", async () => {
    await render(
      <SetupFirstCleanupChoice
        tiered={false}
        value="off"
        onChange={noop}
        price=""
        onPriceChange={noop}
      />,
    );
    expect(host.querySelector("[data-setup-required]")).not.toBeNull();
    expect(host.querySelector("[data-setup-first-cleanup-unchosen]")).toBeNull();
    expect(host.querySelector("#setup-first-cleanup-off")!.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("is not asked, so not marked, when the first cleanup is tiered on Zones", async () => {
    await render(
      <SetupFirstCleanupChoice tiered value={null} onChange={noop} price="" onPriceChange={noop} />,
    );
    expect(host.querySelector("[data-setup-required]")).toBeNull();
    expect(host.querySelector("button[aria-pressed]")).toBeNull();
  });

  it("is the choice step 2 draws, starting unanswered, with the #881 refusal kept", () => {
    expect(SETUP).toMatch(/<SetupFirstCleanupChoice\b/);
    expect(SETUP).toMatch(/useState<SetupFirstCleanup \| null>\(null\)/);
    expect(SETUP).toContain('refuse("Choose whether new clients pay for a first cleanup.")');
  });
});

// ── 2. A ZIP for the centre ──────────────────────────────────────────────────

type Centroid = { zip: string; lat: number; lng: number; radiusM: number };
const CENSUS: Centroid[] = (() => {
  const sql = read("supabase/migrations/20261001120100_the-zip-centers-a-zone-is-filled-from.sql");
  const body = sql.slice(sql.indexOf("$zcta$") + 6, sql.lastIndexOf("$zcta$"));
  return body
    .trim()
    .split("\n")
    .map((l) => {
      const [zip, lat, lng, r] = l.split(",");
      return { zip, lat: Number(lat), lng: Number(lng), radiusM: Number(r) };
    });
})();
const centroid = (zip: string) => {
  const c = CENSUS.find((x) => x.zip === zip);
  return c ? { lat: c.lat, lng: c.lng } : null;
};

function fakeDb() {
  const inserted: Record<string, unknown>[] = [];
  const result = (data: unknown) => ({ data, error: null });
  return {
    inserted,
    rpc: async (name: string, args: any) => {
      if (name !== "zip_centroids_in_box") throw new Error(`unexpected rpc ${name}`);
      return result(
        CENSUS.filter(
          (c) =>
            c.lat >= args._south &&
            c.lat <= args._north &&
            c.lng >= args._west &&
            c.lng <= args._east,
        )
          .slice(0, args._limit)
          .map((c) => ({ zip: c.zip, lat: c.lat, lng: c.lng, radius_m: c.radiusM })),
      );
    },
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return chain;
        },
        single: async () =>
          table === "organizations"
            ? result({ currency: "usd", frequency_multipliers: null })
            : result({ id: "zone-new" }),
        then: (resolve: (v: unknown) => unknown) => resolve(result([])),
      };
      return chain;
    },
  };
}

beforeEach(() => {
  state.db = fakeDb();
});

const DETROIT_ADDRESS = "1 Campus Martius, Detroit, MI 48226";
const DETROIT_PIN = centroid("48226")!;
const FIFTEEN_MILES_M = Math.round(15 * 1609.344);

describe("the area's centre is a ZIP the owner can see and change", () => {
  it("prefills the ZIP from the business address, and lets a cleared field stay cleared", () => {
    expect(zipFromAddress(DETROIT_ADDRESS)).toBe("48226");
    expect(zipFromAddress("12345 Grand River Ave, Detroit, MI 48227-1234, USA")).toBe("48227");
    expect(zipFromAddress("12345 Grand River Ave, Detroit")).toBe("");
    expect(zipFromAddress(null)).toBe("");
    expect(setupAreaZipValue({ typed: "", edited: false, businessAddress: DETROIT_ADDRESS })).toBe(
      "48226",
    );
    expect(setupAreaZipValue({ typed: "", edited: true, businessAddress: DETROIT_ADDRESS })).toBe(
      "",
    );
    expect(
      setupAreaZipValue({ typed: "48933", edited: true, businessAddress: DETROIT_ADDRESS }),
    ).toBe("48933");
  });

  it("a ZIP entered gives an area centred there, with the ZIPs it holds filled", async () => {
    const asked: string[] = [];
    const center = await setupAreaCenter({
      zip: "48933",
      businessAddress: DETROIT_ADDRESS,
      pin: DETROIT_PIN,
      geocode: async (zip) => {
        asked.push(zip);
        return centroid(zip);
      },
    });
    expect(asked).toEqual(["48933"]);
    expect(center).toEqual(centroid("48933"));

    // What setup then sends createZone.
    await createZone({
      data: {
        name: "Main service area",
        geoMatchMode: "radius",
        fillZipsFromShape: true,
        centerLatitude: center.lat,
        centerLongitude: center.lng,
        radiusMeters: FIFTEEN_MILES_M,
        basePriceCents: 2000,
        perDogAddlCents: 0,
      },
    } as any);
    const row = state.db.inserted[0];
    expect(row.center_latitude).toBe(center.lat);
    expect(row.center_longitude).toBe(center.lng);
    const zips = row.zip_codes as string[];
    expect(zips).toContain("48933");
    // Lansing's circle, not Detroit's: the business's own ZIP is 80 miles off.
    expect(zips).not.toContain("48226");
  });

  it("left as the business's own ZIP, it centres on the business's pin, not the ZIP's middle", async () => {
    const geocode = vi.fn(async () => centroid("48226"));
    const center = await setupAreaCenter({
      zip: "48226",
      businessAddress: DETROIT_ADDRESS,
      pin: { lat: 42.3314, lng: -83.0458 },
      geocode,
    });
    expect(center).toEqual({ lat: 42.3314, lng: -83.0458 });
    expect(geocode).not.toHaveBeenCalled();
  });

  it("refuses a ZIP it cannot read, and one it cannot find", async () => {
    expect(setupAreaCenterProblem({ zip: "4893", pin: null })).toMatch(/Enter the ZIP/);
    expect(setupAreaCenterProblem({ zip: "", pin: null })).toMatch(/Enter the ZIP/);
    expect(setupAreaCenterProblem({ zip: "", pin: DETROIT_PIN })).toBeNull();
    expect(setupAreaCenterProblem({ zip: "48933-1234", pin: null })).toBeNull();
    await expect(
      setupAreaCenter({
        zip: "00000",
        businessAddress: null,
        pin: null,
        geocode: async () => null,
      }),
    ).rejects.toThrow(/could not find that ZIP/);
  });

  it("is the field and the centre step 2 uses, for every business, pinned or not", () => {
    expect(SETUP).toContain('id="setup-zone-zip"');
    // The field is no longer the else-branch of "is the business pinned".
    expect(SETUP).not.toMatch(/\{pinned \? \(\s*<p className="text-sm">\s*Centered on/);
    expect(SETUP).toMatch(/await setupAreaCenter\(/);
    expect(SETUP).toMatch(/fillZipsFromShape: true/);
  });
});

// ── 3. No price warning while the price loads ────────────────────────────────

describe("'Set a price per visit first.' waits for the price to load", () => {
  it("says loading, not 'set a price', while the quote is on its way", () => {
    expect(createClientPriceHint({ needsPrice: true, priceLoading: true })).toBe("loading");
    expect(CREATE_CLIENT_PRICE_HINT_COPY.loading).not.toMatch(/Set a price/);
  });

  it("says 'set a price' only once the price has loaded and is empty", () => {
    expect(createClientPriceHint({ needsPrice: true, priceLoading: false })).toBe("set-price");
    expect(CREATE_CLIENT_PRICE_HINT_COPY["set-price"]).toBe("Set a price per visit first.");
    expect(createClientPriceHint({ needsPrice: false, priceLoading: false })).toBeNull();
    expect(createClientPriceHint({ needsPrice: false, priceLoading: true })).toBeNull();
  });

  it("through a delayed load, the hint never reads 'set a price' before the quote answers", () => {
    // The states /clients/new passes through for a $20 zone, quote slow.
    const timeline = [
      { needsPrice: true, priceLoading: true }, // asked, waiting
      { needsPrice: true, priceLoading: true }, // still waiting
      { needsPrice: false, priceLoading: false }, // $20 arrived
    ];
    const said = timeline.map((t) => createClientPriceHint(t));
    expect(said).not.toContain("set-price");
    expect(said.at(-1)).toBeNull();
  });

  it("is what /clients/new draws, keyed on the quote's fetch", () => {
    expect(NEW_CLIENT).toMatch(/const priceLoading = [^;]*quoteQ\.isFetching/);
    expect(NEW_CLIENT).toMatch(/createClientPriceHint\(\{ needsPrice, priceLoading \}\)/);
    // The bare, unconditional sentence is gone.
    expect(NEW_CLIENT).not.toMatch(/\{needsPrice && \(\s*<p[^>]*>Set a price per visit first/);
  });
});
