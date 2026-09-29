// Location is shared only between "on my way" and arrival.
//
// The whole privacy rule of the live map is one window: it opens when the
// customer is told the tech is on the way, and it closes when the tech starts
// the visit, two hours later at most, when the tech presses Stop, or when the
// business turns tracking off. Stated three times, on purpose, and this file
// holds the three copies to each other:
//
//   sharingWindow (src/lib/live-tracking.ts)   the phone and the server fn
//   live_tracking_window_open (the migration)  every write, the page, the prune
//   useShareLocationEnRoute                    what actually stops the device

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHARING_WINDOW_MS, POST_INTERVAL_MS, sharingWindow } from "@/lib/live-tracking";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const SENT = "2026-09-29T15:00:00Z";
const at = (min: number) => new Date(Date.parse(SENT) + min * 60_000);
const open = { enabled: true, status: "scheduled", onMyWaySentAt: SENT, stoppedAt: null };

describe("the window", () => {
  it("opens with the message and says when it will close", () => {
    expect(sharingWindow({ ...open, now: at(1) })).toEqual({
      share: true,
      until: new Date("2026-09-29T17:00:00Z"),
    });
    expect(SHARING_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("is shut before the on-my-way message", () => {
    expect(sharingWindow({ ...open, onMyWaySentAt: null, now: at(1) })).toEqual({
      share: false,
      reason: "not_announced",
    });
    expect(sharingWindow({ ...open, onMyWaySentAt: "not a date", now: at(1) }).share).toBe(false);
  });

  it("is shut once the visit starts, completes, or is skipped", () => {
    for (const status of ["in_progress", "completed", "skipped", "canceled", "missed"]) {
      expect(sharingWindow({ ...open, status, now: at(1) }), status).toEqual({
        share: false,
        reason: "started",
      });
    }
  });

  it("is shut two hours after the message, to the minute", () => {
    expect(sharingWindow({ ...open, now: at(119) }).share).toBe(true);
    expect(sharingWindow({ ...open, now: at(120) })).toEqual({ share: false, reason: "expired" });
    expect(sharingWindow({ ...open, now: at(600) }).share).toBe(false);
  });

  it("is shut with tracking off, whatever else is true", () => {
    expect(sharingWindow({ ...open, enabled: false, now: at(1) })).toEqual({
      share: false,
      reason: "turned_off",
    });
  });

  it("stays shut after Stop, until a newer message reopens it", () => {
    expect(
      sharingWindow({ ...open, stoppedAt: "2026-09-29T15:10:00Z", now: at(11) }),
    ).toEqual({ share: false, reason: "stopped" });
    // Stopped at 15:10, then the button sent "on my way" again at 15:20.
    expect(
      sharingWindow({
        ...open,
        onMyWaySentAt: "2026-09-29T15:20:00Z",
        stoppedAt: "2026-09-29T15:10:00Z",
        now: at(21),
      }).share,
    ).toBe(true);
  });
});

describe("the database states the same window", () => {
  const sql = read("supabase/migrations/20260929100000_nobody-could-see-the-truck-coming.sql");
  const fn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.live_tracking_window_open"),
    sql.indexOf("REVOKE ALL ON FUNCTION public.live_tracking_window_open"),
  );

  it("with the same five conditions", () => {
    expect(fn).toMatch(/COALESCE\(_enabled, false\)/);
    expect(fn).toMatch(/_status = 'scheduled'/);
    expect(fn).toMatch(/_sent_at IS NOT NULL/);
    expect(fn).toMatch(/_at < _sent_at \+ interval '2 hours'/);
    expect(fn).toMatch(/_stopped_at IS NULL OR _stopped_at < _sent_at/);
  });

  it("and every write, the page and the prune go through it", () => {
    const may = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.may_share_live_location"));
    expect(may.slice(0, may.indexOf("$function$;"))).toMatch(/live_tracking_window_open\(/);
    const pub = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.public_visit_tracking"));
    expect(pub.slice(0, pub.indexOf("$function$;"))).toMatch(/_open := public\.live_tracking_window_open\(/);
    const prune = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.prune_visit_live_locations"));
    expect(prune.slice(0, prune.indexOf("$function$;"))).toMatch(/live_tracking_window_open\(/);
    for (const cmd of ["INSERT", "UPDATE"]) {
      expect(sql).toMatch(
        new RegExp(`FOR ${cmd} TO authenticated[\\s\\S]{0,200}?may_share_live_location\\(visit_id, organization_id, staff_id\\)`),
      );
    }
  });

  it("and forgets the position the moment the window closes by an event", () => {
    expect(sql).toMatch(
      /CREATE TRIGGER visit_live_locations_forget_visit\s+AFTER UPDATE OF status, live_tracking_stopped_at ON public\.visits/,
    );
    expect(sql).toMatch(/NEW\.status <> 'scheduled'/);
    expect(sql).toMatch(
      /CREATE TRIGGER visit_live_locations_forget_org\s+AFTER UPDATE OF live_tracking_enabled ON public\.organizations/,
    );
    const nightly = read("src/routes/api/public/hooks/nightly.ts");
    expect(nightly).toMatch(/rpc\("prune_visit_live_locations"\)/);
  });

  it("starts OFF for every business, existing and new", () => {
    expect(sql).toMatch(/live_tracking_enabled boolean NOT NULL DEFAULT false/);
    expect(sql).not.toMatch(/SET\s+live_tracking_enabled\s*=\s*true/i);
  });
});

describe("the phone stops when the window does", () => {
  const hook = read("src/hooks/useShareLocationEnRoute.ts");

  it("shares only for the visit the server names, and only while it is scheduled", () => {
    expect(hook).toMatch(
      /data\.active\.visitId === visit\.id && visit\.status === "scheduled"/,
    );
  });

  it("ends at the two hours on the phone's clock too", () => {
    expect(hook).toMatch(/setTimeout\(\(\) => setExpired\(true\), ms\)/);
  });

  it("stops when the database refuses, and on Stop", () => {
    expect(hook).toMatch(/if \(r\.stop\) \{\s*setRefused\(true\)/);
    expect(hook).toMatch(/const stop = useCallback\(\(\) => \{\s*setStopping\(true\);\s*setRefused\(true\);/);
  });

  it("clears the device watch when sharing ends or the card goes", () => {
    expect(hook).toMatch(/navigator\.geolocation\.clearWatch\(id\)/);
    expect(hook).toMatch(/cancelled = true;\s*stopWatch\?\.\(\);/);
    const native = read("src/lib/native.ts");
    expect(native).toMatch(/Geolocation\.clearWatch\(\{ id \}\)/);
  });

  it("posts every 30 seconds at most, and never from a hidden page", () => {
    expect(POST_INTERVAL_MS).toBe(30_000);
    expect(hook).toMatch(/setInterval\(\(\) => void send\(\), POST_INTERVAL_MS\)/);
    expect(hook).toMatch(/document\.visibilityState === "hidden"\) return;/);
    // Never a fix the phone got more than two minutes ago.
    expect(hook).toMatch(/if \(!fix \|\| Date\.now\(\) - fix\.at > STALE_FIX_MS\) return;/);
    expect(hook).toMatch(/const STALE_FIX_MS = 2 \* 60_000;/);
  });

  it("is on My Day in one line, and never on an office preview", () => {
    const myDay = read("src/routes/_authenticated/my-day.tsx");
    expect(myDay.match(/<EnRouteLocationChip /g)?.length).toBe(1);
    expect(myDay).toMatch(/\{!preview && <EnRouteLocationChip visit=\{visit\} \/>\}/);
  });

  it("tells the tech, with a Stop button a thumb can hit", () => {
    const chip = read("src/components/EnRouteLocationChip.tsx");
    expect(chip).toMatch(/Sharing your location with \{s\.customerName\} until you arrive/);
    expect(chip).toMatch(/onClick=\{s\.stop\}/);
    expect(chip).toMatch(/touch:min-h-11 touch:min-w-11/);
  });
});
