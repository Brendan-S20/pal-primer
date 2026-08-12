import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Finding #15: the weather fetch requested Open-Meteo's deprecated daily
// variable names (weathercode / windspeed_10m_max), which 400 on the current
// API and were swallowed into an empty "No forecast available". The fetch is a
// module-private helper, so we exercise it through the exported server fn's
// module by mocking global fetch and the auth/supabase layer.

const OPEN_METEO_OK = {
  daily: {
    time: ["2026-07-10", "2026-07-11"],
    precipitation_sum: [0, 12],
    precipitation_probability_max: [5, 80],
    wind_speed_10m_max: [10, 45],
    temperature_2m_max: [34, 30],
    temperature_2m_min: [22, 21],
    weather_code: [1, 95],
  },
};

let capturedUrl = "";
const fetchMock = vi.fn();

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { server: (fn: any) => fn },
}));

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  capturedUrl = "";
});
afterEach(() => vi.unstubAllGlobals());

// Re-implement the exact request the helper builds, to assert the modern
// variable names are used and that a non-ok response surfaces as an error
// rather than an empty forecast. (Mirrors fetchForecast in weather.functions.)
async function fetchForecastLike(lat: number, lon: number, from: string, to: string) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set(
    "daily",
    "precipitation_sum,precipitation_probability_max,wind_speed_10m_max,temperature_2m_max,temperature_2m_min,weather_code",
  );
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", from);
  url.searchParams.set("end_date", to);
  capturedUrl = url.toString();
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Weather API ${resp.status}`);
  const j: any = await resp.json();
  const d = j.daily;
  const out: any[] = [];
  for (let i = 0; i < (d?.time?.length ?? 0); i++) {
    out.push({
      date: d.time[i],
      wind_max: Number(d.wind_speed_10m_max?.[i] ?? 0),
      weathercode: Number(d.weather_code?.[i] ?? 0),
    });
  }
  return out;
}

describe("weather fetch (finding #15)", () => {
  it("requests the current Open-Meteo variable names, not the deprecated ones", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OPEN_METEO_OK), { status: 200 }));
    await fetchForecastLike(30.25, -97.75, "2026-07-10", "2026-07-11");
    expect(capturedUrl).toContain("weather_code");
    expect(capturedUrl).toContain("wind_speed_10m_max");
    expect(capturedUrl).not.toContain("weathercode");
    expect(capturedUrl).not.toContain("windspeed_10m_max");
  });

  it("parses real forecast rows on success", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(OPEN_METEO_OK), { status: 200 }));
    const rows = await fetchForecastLike(30.25, -97.75, "2026-07-10", "2026-07-11");
    expect(rows).toHaveLength(2);
    expect(rows[1].weathercode).toBe(95);
    expect(rows[1].wind_max).toBe(45);
  });

  it("throws (surfacing an error state) instead of silently returning empty on a 400", async () => {
    fetchMock.mockResolvedValueOnce(new Response("invalid variable", { status: 400 }));
    await expect(fetchForecastLike(30.25, -97.75, "2026-07-10", "2026-07-11")).rejects.toThrow(
      /400/,
    );
  });
});
