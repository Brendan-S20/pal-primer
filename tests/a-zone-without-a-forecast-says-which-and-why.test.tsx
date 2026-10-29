// A zone without a forecast says which zone and why (#455).
//
// The weather popover said "Couldn't load 4 zones (missing coordinates or
// weather service error)": not which four, not which of the two, and no way
// to try again. And the server asked Open-Meteo once per ZONE, all at once,
// so zones stacked on one town sent the same question several times in the
// same instant and a business with many zones met the rate limit.
//
// Then one Retry under the list re-fetched every zone. Each zone the service
// did not answer now has its own Retry, which asks for that zone alone and
// says on the zone's line when it is retrying and when a retry failed again.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (f: unknown) => f,
  createServerFn: () => {
    function chain(): unknown {
      return chain;
    }
    return Object.assign(chain, { inputValidator: chain, middleware: chain, handler: chain });
  },
  createMiddleware: () => {
    const chain: Record<string, unknown> = {};
    chain.server = () => chain;
    chain.client = () => chain;
    chain.middleware = () => chain;
    return chain;
  },
}));
vi.mock("@/hooks/useOrgToday", () => ({ useOrgToday: () => "2026-10-14" }));

const { FailedZones, withZone, RETRY_FAILED } = await import("@/components/WeatherPopover");
const { forecastLimiter } = await import("@/lib/weather.functions");

const text = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ");

const none: ReadonlySet<string> = new Set();
const RIVERBEND = [
  { id: "z1", name: "Riverbend North", status: "no_coords" as const, error: null },
  {
    id: "z2",
    name: "Riverbend South",
    status: "error" as const,
    error: "The weather service is temporarily rate-limited.",
  },
  { id: "z3", name: "Riverbend East", status: "error" as const, error: null },
];

function failed(over: Partial<Parameters<typeof FailedZones>[0]> = {}) {
  return createElement(FailedZones, {
    zones: RIVERBEND,
    retrying: none,
    retried: none,
    onRetry: () => {},
    ...over,
  });
}

/** Every element in a rendered tree whose props carry an aria-label. */
type Props = Record<string, unknown> & { onClick?: () => void };
function labelled(node: unknown, out: Array<{ label: string; props: Props }> = []) {
  if (Array.isArray(node)) node.forEach((n) => labelled(n, out));
  else if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props: Props }).props;
    if (typeof props["aria-label"] === "string") out.push({ label: props["aria-label"], props });
    labelled(props.children, out);
  }
  return out;
}

describe("the zones with no forecast", () => {
  it("names each zone and says why", () => {
    const out = text(failed());
    expect(out).toContain("Riverbend North : no location set. Add one in Zones");
    expect(out).toContain("Riverbend South : The weather service is temporarily rate-limited.");
    expect(out).toContain("Riverbend East : the weather service did not answer.");
    expect(out).not.toMatch(/Couldn't load \d+ zones?/);
  });

  it("gives each zone the service did not answer its own Retry, and none to a zone with no location", () => {
    const html = renderToStaticMarkup(failed());
    expect(html).toContain('aria-label="Retry Riverbend South"');
    expect(html).toContain('aria-label="Retry Riverbend East"');
    expect(html).not.toContain('aria-label="Retry Riverbend North"');
    expect(html.match(/>Retry</g)).toHaveLength(2);
  });

  it("a zone's Retry asks for that zone", () => {
    const asked: string[] = [];
    const tree = FailedZones({
      zones: RIVERBEND,
      retrying: none,
      retried: none,
      onRetry: (id) => asked.push(id),
    });
    for (const { label, props } of labelled(tree)) {
      if (label.startsWith("Retry ")) props.onClick?.();
    }
    expect(asked).toEqual(["z2", "z3"]);
  });

  it("shows retrying on that zone only, and keeps the other zone's Retry live", () => {
    const html = renderToStaticMarkup(failed({ retrying: new Set(["z2"]) }));
    const out = text(failed({ retrying: new Set(["z2"]) }));
    expect(out).toContain("Riverbend South : asking the weather service again…");
    expect(out).toContain("Retrying…");
    expect(html).toMatch(/aria-label="Retry Riverbend South"[^>]*disabled/);
    expect(html).not.toMatch(/aria-label="Retry Riverbend East"[^>]*disabled/);
    expect(out).toContain("Riverbend East : the weather service did not answer.");
  });

  it("says when a retry failed again, on that zone's line", () => {
    const out = text(failed({ retried: new Set(["z3"]) }));
    expect(out).toContain(
      "Riverbend East : the weather service did not answer. Tried again; still no answer.",
    );
    expect(out).not.toMatch(/rate-limited\. Tried again/);
  });

  it("draws nothing when every zone loaded", () => {
    expect(renderToStaticMarkup(failed({ zones: [] }))).toBe("");
  });

  it("a retry that succeeds turns that zone into a forecast and leaves the others as they were", () => {
    const zone = (id: string, status: "ok" | "error" | "no_coords") => ({
      id,
      name: id,
      postal_prefix: null,
      latitude: 42,
      longitude: -83,
      status,
      error: status === "error" ? "busy" : null,
      stale: false,
      days: [],
    });
    const ok = zone("z0", "ok");
    const noLoc = zone("z1", "no_coords");
    const before = { zones: [ok, noLoc, zone("z2", "error"), zone("z3", "error")] };
    const answered = { ...zone("z2", "ok"), name: "Riverbend South" };
    const after = withZone(before, answered)!;
    expect(after.zones.map((z) => z.status)).toEqual(["ok", "no_coords", "ok", "error"]);
    expect(after.zones[2]).toBe(answered);
    expect(after.zones[0]).toBe(ok);
    expect(after.zones[1]).toBe(noLoc);
    expect(after.zones[3]).toBe(before.zones[3]);
    expect(before.zones[2].status).toBe("error");
    expect(withZone(undefined, answered)).toBeUndefined();
  });

  it("a retry request that throws shows fixed copy, not the thrown text", async () => {
    expect(RETRY_FAILED).toBe("the weather service did not answer.");
    const { readFileSync } = await import("node:fs");
    const popover = readFileSync("src/components/WeatherPopover.tsx", "utf8");
    expect(popover).toMatch(/\} catch \{[\s\S]{0,300}error: RETRY_FAILED/);
    expect(popover).not.toMatch(/error: e instanceof Error \? e\.message/);
  });

  it("a retry asks the server for one zone, and the server can answer for one zone", async () => {
    const { readFileSync } = await import("node:fs");
    const popover = readFileSync("src/components/WeatherPopover.tsx", "utf8");
    const server = readFileSync("src/lib/weather.functions.ts", "utf8");
    expect(popover).toMatch(/zoneIds: \[zoneId\]/);
    expect(popover).not.toMatch(/onRetry=\{\(\) => query\.refetch\(\)\}/);
    expect(server).toMatch(/zoneIds: z\.array\(z\.string\(\)\.uuid\(\)\)/);
    expect(server).toMatch(
      /if \(data\.zoneIds\) zonesQuery = zonesQuery\.in\("id", data\.zoneIds\);/,
    );
  });
});

describe("the server asks a few points at a time", () => {
  it("never runs more than the limit at once, and runs them all", async () => {
    const limit = forecastLimiter(3);
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 1));
          active--;
          done.push(i);
          return i;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("a failed task frees its place", async () => {
    const limit = forecastLimiter(1);
    await expect(limit(async () => Promise.reject(new Error("429")))).rejects.toThrow("429");
    await expect(limit(async () => "next")).resolves.toBe("next");
  });

  it("shares one lookup per point across the zones on it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/weather.functions.ts", "utf8");
    expect(src).toMatch(/const key = `\$\{lat\.toFixed\(2\)\},\$\{lon\.toFixed\(2\)\}`;/);
    expect(src).toMatch(/await forecastFor\(z\.latitude, z\.longitude\)/);
  });
});
