// The route on the lock screen: the JS side of the RouteActivity plugin.
//
// iOS only. Everything here is a no-op that resolves to "nothing happened" on
// the web and on Android, where there is no Live Activity to start, so My Day
// can call it unconditionally. The native half is a LOCAL plugin inside the
// iOS app target (ios/App/App/LiveActivity/RouteActivityPlugin.swift),
// registered by HSBridgeViewController, and reached here by name through
// registerPlugin; there is no npm package behind it.
//
// Failures are reported, never thrown: a lock screen that does not update is
// a lesser problem than a Complete button that throws because of it. Each one
// reaches Sentry tagged area: live_activity with the step it failed at.
// "Live Activities are switched off in Settings" is the person's choice, not
// a fault, and is reported once as a warning rather than as an error.

import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { isNative, platform } from "@/lib/native";
import { reportClientError, reportClientIssue } from "@/lib/monitoring/client";
import type { RouteActivityState } from "@/lib/live-activity-state";

export type DismissalPolicy = "immediate" | "default" | { after: Date };

type StartResult = { id: string; pushToken?: string; reused?: boolean; pushError?: string };
type UpdateResult = { updated: boolean; id?: string; pushToken?: string };
export type TokenEvent = { id: string; token: string; routeDate: string };
export type EndedEvent = { id: string; routeDate: string };

interface RouteActivityPlugin {
  isSupported(): Promise<{ supported: boolean; enabled: boolean }>;
  start(options: {
    attributes: { routeDate: string; title: string };
    state: RouteActivityState;
  }): Promise<StartResult>;
  update(options: { state: RouteActivityState }): Promise<UpdateResult>;
  end(options: {
    state?: RouteActivityState;
    dismissalPolicy: "immediate" | "default" | "after";
    dismissAt?: number;
  }): Promise<{ ended: number; ids?: string[] }>;
  addListener(event: "pushToken", fn: (e: TokenEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "ended", fn: (e: EndedEvent) => void): Promise<PluginListenerHandle>;
}

let plugin: RouteActivityPlugin | null = null;
function native(): RouteActivityPlugin {
  plugin ??= registerPlugin<RouteActivityPlugin>("RouteActivity");
  return plugin;
}

/** True only inside the iOS app. Every call below checks it first. */
export function liveActivityAvailable(): boolean {
  try {
    return isNative() && platform() === "ios";
  } catch {
    return false;
  }
}

const TAGS = { area: "live_activity" } as const;
let warnedDisabled = false;

function report(step: string, e: unknown) {
  const code = (e as { code?: string } | null)?.code;
  if (code === "DISABLED") {
    if (!warnedDisabled) {
      warnedDisabled = true;
      reportClientIssue("Live Activities are switched off for HoundStack", { ...TAGS, step }, "info");
    }
    return;
  }
  if (code === "UNSUPPORTED") return;
  reportClientError(e, { ...TAGS, step });
}

/** Whether this phone can show one (iOS 16.2+), and whether the person has
 *  them switched on. Both false everywhere but the iOS app. */
export async function liveActivitySupport(): Promise<{ supported: boolean; enabled: boolean }> {
  if (!liveActivityAvailable()) return { supported: false, enabled: false };
  try {
    return await native().isSupported();
  } catch (e) {
    report("is_supported", e);
    return { supported: false, enabled: false };
  }
}

/** Put the day's route on the lock screen, or update the one already there
 *  for the same day. Null when it could not, or when this is not the iOS app. */
export async function startRouteActivity(
  routeDate: string,
  title: string,
  state: RouteActivityState,
): Promise<StartResult | null> {
  if (!liveActivityAvailable()) return null;
  try {
    const r = await native().start({ attributes: { routeDate, title }, state });
    if (r.pushError) {
      // Shown, but the office's changes cannot reach it. Worth knowing about
      // on a real phone; expected on a simulator with signing off.
      reportClientIssue(`Live Activity started without a push token: ${r.pushError}`, {
        ...TAGS,
        step: "push_token",
      });
    }
    return r;
  } catch (e) {
    report("start", e);
    return null;
  }
}

/** Bring the lock screen up to date. Resolves `updated: false` -- and does
 *  nothing -- when no route is showing, so it is safe to call on every change. */
export async function updateRouteActivity(state: RouteActivityState): Promise<UpdateResult | null> {
  if (!liveActivityAvailable()) return null;
  try {
    return await native().update({ state });
  } catch (e) {
    report("update", e);
    return null;
  }
}

/** Take the route off the lock screen. With a state, its last words; with
 *  `{ after }`, iOS leaves the final state up until then. Resolves to the ids
 *  of the activities it ended, empty when nothing was showing. */
export async function endRouteActivity(
  state: RouteActivityState | undefined,
  policy: DismissalPolicy,
): Promise<string[]> {
  if (!liveActivityAvailable()) return [];
  try {
    const r = await native().end(
      typeof policy === "object"
        ? { state, dismissalPolicy: "after", dismissAt: policy.after.getTime() }
        : { state, dismissalPolicy: policy },
    );
    return r.ids ?? [];
  } catch (e) {
    report("end", e);
    return [];
  }
}

/** Follow the activity's push token (it can rotate) and its end (the person
 *  swiped it away). Returns the cleanup. A no-op off iOS. */
export function onRouteActivityEvents(handlers: {
  onToken: (e: TokenEvent) => void;
  onEnded: (e: EndedEvent) => void;
}): () => void {
  if (!liveActivityAvailable()) return () => {};
  const handles: Promise<PluginListenerHandle>[] = [];
  try {
    handles.push(native().addListener("pushToken", handlers.onToken));
    handles.push(native().addListener("ended", handlers.onEnded));
  } catch (e) {
    report("listen", e);
  }
  return () => {
    for (const h of handles) void h.then((x) => x.remove()).catch(() => {});
  };
}

/** Test hook: forget the plugin proxy and the once-only warning. */
export function resetLiveActivityForTests() {
  plugin = null;
  warnedDisabled = false;
}
