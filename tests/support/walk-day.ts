import type { RouteDayInputs } from "@/lib/route-inputs";

const morning = { earliestTime: "11:00", latestTime: "13:00" };
const afternoon = { earliestTime: "16:00", latestTime: "18:00" };

export function walkDay(): RouteDayInputs {
  return {
    org: {
      timezone: "America/Chicago",
      workday_start: "08:00",
      workday_end: "19:00",
      park_walk_min: 2,
      road_factor: 1.35,
      speed_kmh: 30,
      measured_legs: null,
      max_drive_minutes: 240,
      route_windows: "honour",
      latitude: 30,
      longitude: -97,
    },
    techs: [
      {
        id: "walker-a",
        capacity: 660,
        start_lat: 30,
        start_lon: -97,
        end_lat: null,
        end_lon: null,
        current_min: null,
        current_stops: null,
        current_sequenced: null,
      },
    ],
    visits: [morning, afternoon].map((window, i) => ({
      id: `walk-${i}`,
      lat: 30.01,
      lon: -97.01,
      service_min: 30,
      earliest: window.earliestTime,
      latest: window.latestTime,
      pref: "any",
      assigned_staff_id: null,
      fixed: false,
      service_id: "walk-service",
    })),
    dumps: [],
    day_centroid: { lat: 30.01, lon: -97.01 },
    points: [],
    legs: [],
  };
}
