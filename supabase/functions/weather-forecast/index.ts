// Open-Meteo relay (deployed as the `weather-forecast` Supabase Edge Function).
//
// The app server's egress cannot always reach api.open-meteo.com directly, so
// src/lib/weather.functions.ts falls back to this function, which has
// unrestricted egress and mirrors the exact request the server builds (same
// daily variables, timezone=auto, start/end dates). This file is the committed
// source of the deployed function — keep the request shape in sync with
// fetchForecast in weather.functions.ts.
//
// POST { latitude, longitude, fromDate, toDate } → upstream Open-Meteo body
// (status passed through), 400 on invalid input, 502 when upstream is
// unreachable.

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: {
    latitude?: unknown;
    longitude?: unknown;
    fromDate?: unknown;
    toDate?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  const fromDate = String(body.fromDate ?? "");
  const toDate = String(body.toDate ?? "");

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return json({ error: "Invalid latitude" }, 400);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return json({ error: "Invalid longitude" }, 400);
  }
  if (!DATE_RE.test(fromDate) || !DATE_RE.test(toDate)) {
    return json({ error: "Dates must be YYYY-MM-DD" }, 400);
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  // Current Open-Meteo daily variable names — the legacy ones (weathercode,
  // windspeed_10m_max) 400 on the modern API. Keep in sync with the server.
  url.searchParams.set(
    "daily",
    "precipitation_sum,precipitation_probability_max,wind_speed_10m_max,temperature_2m_max,temperature_2m_min,weather_code",
  );
  // Fahrenheit / mph / inches. This relay is not a neutral pipe: the caller
  // parses whatever comes back into fields it believes are °F and mph, so if
  // these three lines drift from the server's copy in
  // src/lib/weather.functions.ts, the units of the board depend on which
  // network path happened to succeed — and the direct path is the one that
  // fails in production, so this file is usually the one deciding.
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", fromDate);
  url.searchParams.set("end_date", toDate);

  try {
    const upstream = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return json(
      { error: `Weather upstream unreachable: ${(e as Error).message}` },
      502,
    );
  }
});
