// A zone without a forecast says which zone and why (#455).
//
// The weather popover said "Couldn't load 4 zones (missing coordinates or
// weather service error)": not which four, not which of the two, and no way
// to try again. And the server asked Open-Meteo once per ZONE, all at once,
// so zones stacked on one town sent the same question several times in the
// same instant and a business with many zones met the rate limit.

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

const { FailedZones } = await import("@/components/WeatherPopover");
const { forecastLimiter } = await import("@/lib/weather.functions");

const text = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ");

describe("the zones with no forecast", () => {
  it("names each zone and says why", () => {
    const out = text(
      createElement(FailedZones, {
        zones: [
          { id: "z1", name: "Riverbend North", status: "no_coords", error: null },
          {
            id: "z2",
            name: "Riverbend South",
            status: "error",
            error: "The weather service is temporarily rate-limited.",
          },
        ],
        retrying: false,
        onRetry: () => {},
      }),
    );
    expect(out).toContain("Riverbend North : no location set. Add one in Zones");
    expect(out).toContain("Riverbend South : The weather service is temporarily rate-limited.");
    expect(out).not.toMatch(/Couldn't load \d+ zones?/);
  });

  it("offers Retry when a service error could clear, and not for a zone with no location", () => {
    const retry = (status: "error" | "no_coords") =>
      text(
        createElement(FailedZones, {
          zones: [{ id: "z1", name: "Zone", status, error: null }],
          retrying: false,
          onRetry: () => {},
        }),
      );
    expect(retry("error")).toContain("Retry");
    expect(retry("no_coords")).not.toContain("Retry");
  });

  it("draws nothing when every zone loaded", () => {
    expect(
      renderToStaticMarkup(
        createElement(FailedZones, { zones: [], retrying: false, onRetry: () => {} }),
      ),
    ).toBe("");
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
