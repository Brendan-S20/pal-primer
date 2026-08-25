// The tech tapped Complete in a dead zone and nothing was written anywhere.
//
// ── THE FAULT ─────────────────────────────────────────────────────────────
//
// Every field write queues by calling `runOrQueue` from INSIDE `mutationFn`.
// React Query's default `networkMode` is `"online"`, and on that setting it
// does not call `mutationFn` at all while the device is offline — it pauses
// the mutation and waits. From the installed query-core:
//
//   canFetch(mode) = (mode ?? "online") === "online" ? onlineManager.isOnline() : true
//   canStart       = () => canFetch(config.networkMode) && config.canRun()
//   if (canStart()) run()          // run() is the only caller of the fn
//
// So the queue code was unreachable in exactly the condition it exists for.
// `isPending` stayed true (button disabled for ever), neither onSuccess nor
// onError fired (no toast), and `scoop-offline.actions` stayed empty. A
// force-quit lost the stop.
//
// Photos were the accidental exception — uploadPhoto is a plain async function
// rather than a useMutation, so it was never paused. That split is what the
// owner described as "some operate as needed, some don't".
//
// A COLD launch already offline worked, because onlineManager initialises to
// `true` and only tracks events. That is why it survived testing.
//
// ── WHY A SOURCE TEST ─────────────────────────────────────────────────────
//
// The fault is one word in a config object, and reproducing it needs a real
// onlineManager, a real IndexedDB and a network transition. What actually has
// to hold is small and durable: mutations must not be left on the default.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const router = readFileSync(join(root, "src/router.tsx"), "utf8");

describe("field writes can reach the queue while offline", () => {
  it("sets mutations to offlineFirst so mutationFn is always entered", () => {
    const mutations = router.slice(router.indexOf("mutations: {"));
    expect(mutations.slice(0, mutations.indexOf("},"))).toMatch(/networkMode: "offlineFirst"/);
  });

  it("still lets runOrQueue be the thing that decides, not the query client", () => {
    // If a future change adds a retry policy here that pauses while offline,
    // the pause comes back by another door.
    const mutations = router.slice(router.indexOf("mutations: {"));
    expect(mutations.slice(0, mutations.indexOf("},"))).not.toMatch(/networkMode: "online"/);
  });

  it("the library still behaves the way this fix assumes", () => {
    // Pins the reason rather than the conclusion. If a react-query upgrade
    // changes what `online` means, this fails and names the file to re-read
    // instead of leaving a config value nobody can justify.
    const core = readFileSync(
      join(root, "node_modules/@tanstack/query-core/build/modern/retryer.js"),
      "utf8",
    );
    expect(core).toMatch(/=== "online"\s*\?\s*onlineManager\.isOnline\(\)\s*:\s*true/);
    expect(core).toMatch(/canFetch\(config\.networkMode\)/);
  });
});
