// The write path into the basement garage got fixed and the read path did not,
// which is a worse state than either being broken on its own: the tech can now
// log a waste station from a place with no signal, and has nothing to log.
//
// The reason it went unnoticed is that it LOOKED covered. "visit-stations" has
// been on the offline read allowlist since the read cache was written, next to
// "my-day" and "my-org", with a comment explaining what it is for. But the
// allowlist says what MAY be written to a device, not what ever gets fetched,
// and nothing ever fetched it in a place it could succeed:
//
//   * the query lives inside StationsSubpanel;
//   * the subpanel renders only while `showStations`;
//   * a tech taps Stations when they are standing at the stations — the
//     underground parking level of an apartment complex, where the bins are
//     and the signal is not.
//
// So the one fetch that could have filled the allowlisted slot was always
// attempted from the one place it could not complete. `dehydrate` had nothing
// to write, the disk store never carried a station list, and the panel opened
// empty every time. My Day now prefetches it for the commercial and multi-unit
// stops on the day, while the truck still has a bar.
//
// THE PREFETCH ALONE IS NOT ENOUGH, and this is the part that would have
// shipped looking finished. React Query drops a query five minutes after its
// last observer goes away, and a prefetched query never has one. A list
// fetched at 7am was out of memory by 7:05, so `dehydrate` still had nothing
// to write and the tech still reached the property at 11 with an empty panel.
// The explicit gcTime is the fix; the prefetch is only the trigger.
//
// AND THE BUDGET ORDER HAD TO CHANGE WITH IT. The device store sorted
// newest-first and stopped at 512KB, which was the whole answer while every
// entry was a day's route. A prefetch for a visit necessarily resolves AFTER
// the route that named the visit, so on a device near the ceiling today's
// station lists are newer than today's route and evict it. A tech would open
// the app in a dead zone holding a complete set of station lists for visits
// they cannot see. A route with no station lists is a bad morning; station
// lists with no route is no morning at all.
//
// Two smaller things the empty panel had been hiding. It answered a MISSING
// response with "No waste stations configured for this property. Ask the
// office to add them." — telling a tech standing in front of a row of bins
// that the property has none, which is a specific, confident, wrong
// instruction. And the row of a station whose log went to the queue looked
// exactly like a station nobody had touched, on the screen where the only way
// to tell one grey bin from the next is what the app says about it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// LAZY, every one of them. The mutation test for this file stashes src/, so
// these paths are briefly absent by design — and a read (or an import) in a
// `describe` body throws during collection, which makes vitest report "no
// tests" rather than N failures. "No tests" reads as a pass.
const read = (p: string) => () => readFileSync(join(ROOT, p), "utf8");
const myDaySrc = read("src/routes/_authenticated/my-day.tsx");
const policySrc = read("src/lib/offline/read-cache-policy.ts");

/** Comments and JSX comment blocks stripped.
 *
 *  Everything asserted below is also EXPLAINED a few lines above itself in the
 *  source, naming the behaviour it replaced, so a match against raw text would
 *  find the explanation and pass while the code stayed wrong. my-day.tsx is
 *  TSX, so the brace-wrapped comment blocks inside its markup have to go too —
 *  the first replace below is what removes them. */
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*"));
    })
    .join("\n");

const NOW = Date.parse("2026-08-09T07:10:00.000Z");
const MINUTE = 60_000;

/** A dehydrated entry, small enough that the budget in each test counts whole
 *  entries rather than bytes — the question here is ORDER, not arithmetic. */
const entry = (queryKey: unknown[], dataUpdatedAt: number) => ({
  queryKey,
  state: { dataUpdatedAt },
});
const rootsOf = (kept: { queryKey: unknown }[]) => kept.map((k) => (k.queryKey as string[])[0]);

describe("the day's route outranks the station lists prefetched from it", () => {
  it("keeps the route when a newer station list would have taken its place", async () => {
    const { selectPersistableQueries } = await import("@/lib/offline/read-cache-policy");

    // The real ordering on a device: My Day resolves, and each commercial stop's
    // station list is prefetched off the back of it, so every station entry
    // carries a LATER dataUpdatedAt than the route that named it.
    const kept = selectPersistableQueries(
      [
        entry(["visit-stations", "visit-1"], NOW + 2 * MINUTE),
        entry(["visit-stations", "visit-2"], NOW + MINUTE),
        entry(["my-day", "2026-08-09", ""], NOW),
      ],
      { maxBytes: 20, sizeOf: () => 10 },
    );

    // Room for two. Purely newest-first, both of them were station lists and
    // the tech launched into a dead zone with no route at all.
    expect(rootsOf(kept)).toEqual(["my-day", "visit-stations"]);
    expect((kept[1].queryKey as string[])[1]).toBe("visit-1");
  });

  it("keeps the org too — without it the shell will not render the route", async () => {
    const { selectPersistableQueries } = await import("@/lib/offline/read-cache-policy");

    const kept = selectPersistableQueries(
      [
        entry(["visit-stations", "visit-1"], NOW + 2 * MINUTE),
        entry(["my-org"], NOW - 30 * MINUTE),
      ],
      { maxBytes: 10, sizeOf: () => 10 },
    );

    expect(rootsOf(kept)).toEqual(["my-org"]);
  });

  it("still lets age decide between two station lists", async () => {
    // Rank orders the KINDS of data. Within one kind the original rule stands,
    // or a device that had accumulated days would start keeping the stalest
    // copy it owned.
    const { selectPersistableQueries } = await import("@/lib/offline/read-cache-policy");

    const kept = selectPersistableQueries(
      [
        entry(["visit-stations", "yesterday"], NOW - 24 * 60 * MINUTE),
        entry(["visit-stations", "today"], NOW),
      ],
      { maxBytes: 10, sizeOf: () => 10 },
    );

    expect((kept[0].queryKey as string[])[1]).toBe("today");
  });

  it("still refuses everything that is not a field read", async () => {
    // The premise of all of the above. Ranking decides who wins the budget;
    // the allowlist decides who is allowed to compete, and a lost phone must
    // not carry the client directory whatever its rank would have been.
    const { isPersistableQueryKey } = await import("@/lib/offline/read-cache-policy");

    expect(isPersistableQueryKey(["visit-stations", "visit-1"])).toBe(true);
    expect(isPersistableQueryKey(["clients"])).toBe(false);
    expect(isPersistableQueryKey(["invoices"])).toBe(false);
  });

  it("names visit-stations in the ranking, not just in the allowlist", async () => {
    // An allowlisted root with no rank sorts LAST by design, so this passing
    // by accident — because the fallback happened to put it in the right place
    // — is exactly the state that breaks when the next root is added.
    const src = codeOnly(policySrc());
    expect(src).toMatch(/BUDGET_RANK[\s\S]{0,200}"visit-stations"/);
    expect(src).toMatch(/budgetRank\(a\.queryKey\)\s*-\s*budgetRank\(b\.queryKey\)/);
  });
});

describe("the station list is fetched where there is still signal", () => {
  it("prefetches it from the day's list rather than waiting for the panel", async () => {
    const src = codeOnly(myDaySrc());
    expect(src).toMatch(/prefetchQuery\(\{[\s\S]{0,200}queryKey: \["visit-stations"/);
  });

  it("prefetches only the stops that can have stations", async () => {
    // The same test the Stations button uses. Fetching one per house would
    // spend the device's whole byte budget proving that residential properties
    // have no bins.
    const src = codeOnly(myDaySrc());
    const effect = src.slice(src.indexOf("const stationsFn"), src.indexOf("prefetchQuery"));
    expect(effect).toMatch(/account_type === "commercial"/);
    expect(effect).toMatch(/has_units/);
  });

  it("does not mint a failed query per commercial stop while offline", async () => {
    // A failed query is never persisted, so an offline prefetch sweep would
    // evict nothing, store nothing, and burn a request per stop on a
    // connection the tech may be about to need for a sync.
    const src = codeOnly(myDaySrc());
    const effect = src.slice(src.indexOf("const stationsFn"), src.indexOf("prefetchQuery"));
    expect(effect).toMatch(/if \(!online/);
  });

  it("holds the prefetched list for as long as the device may keep the day", async () => {
    // THE load-bearing line. Without an explicit gcTime the default five
    // minutes applies, the prefetched query has no observer to hold it, and
    // the whole change becomes a fetch whose result is collected before
    // anything writes it to disk. Tied to the read cache's own ceiling so
    // memory and disk expire on one rule rather than two.
    const src = codeOnly(myDaySrc());
    expect(src).toMatch(/gcTime: READ_CACHE_MAX_AGE_MS/);
    // Imported from the read cache's own module, never a duration typed out
    // here — two ceilings that mean the same thing drift apart, and the one
    // that drifts is discovered by a tech with an empty panel.
    expect(src).toMatch(
      /READ_CACHE_MAX_AGE_MS,[\s\S]{0,120}from "@\/lib\/offline\/read-cache-policy"/,
    );
  });

  it("gives the panel the same options the prefetch used", async () => {
    // Both sites are the SAME query. React Query keeps the longest gcTime any
    // observer asked for, so the panel taking the default would still work —
    // on the prefetch's setting, silently, until somebody edits the prefetch.
    const src = codeOnly(myDaySrc());
    const definitions = [
      ...src.matchAll(/queryKey: \["visit-stations", [\w.]+\],\s*\n\s*queryFn:/g),
    ];

    // One in the prefetch on the day's list, one in the panel. `invalidateQueries`
    // also names the key and is deliberately not matched: it has no queryFn.
    expect(definitions.length).toBe(2);
    for (const match of definitions) {
      const block = src.slice(match.index, match.index + 800);
      expect(block, "a visit-stations query without the shared cache options").toContain(
        "...VISIT_STATIONS_CACHE",
      );
    }
  });
});

describe("what the panel says when it has no copy", () => {
  it("stops telling the tech the property has no stations", async () => {
    // "No waste stations configured for this property. Ask the office to add
    // them." is an answer from the server. It was printed whenever `data` was
    // missing for ANY reason, including the fetch failing in the dead zone the
    // panel is opened in. Not knowing has to look different from knowing there
    // are none.
    const src = codeOnly(myDaySrc());
    expect(src).toMatch(/No saved copy of this property's stations/);
    expect(src).toMatch(/if \(!data\) \{/);

    // And the honest copy has to come FIRST — a `stations.length === 0` branch
    // ahead of it catches the missing-data case on the way past and prints the
    // wrong sentence anyway.
    expect(src.indexOf("No saved copy of this property's stations")).toBeLessThan(
      src.indexOf("No waste stations configured for this property"),
    );
  });
});

describe("a station whose log is still on the device", () => {
  it("marks the row, not just the visit card", async () => {
    // The green "saved" tick comes from the server's own logs, so offline every
    // row a tech had just filled in read as untouched — while they worked down
    // a wall of identical bins with no other way to tell which were done.
    const src = codeOnly(myDaySrc());
    expect(src).toMatch(/queued=\{queuedStationIds\.has\(/);
    expect(src).toMatch(/queued \?/);
  });

  it("reads the queue rather than remembering the save in component state", async () => {
    // The panel closes, the card collapses, and the app gets killed in a
    // pocket, all between the first station and the last. Component state
    // survives none of those; IndexedDB survives all three.
    const src = codeOnly(myDaySrc());
    const hook = src.slice(
      src.indexOf("function useQueuedStationIds"),
      src.indexOf("function StationsSubpanel"),
    );
    expect(hook).toMatch(/listPending\(userId\)/);
    expect(hook).toMatch(/a\.kind === "station" && a\.visitId === visitId/);
    // Scoped to the signed-in tech for the reason every read of this queue is:
    // on a shared tablet the previous tech's queued logs are not this tech's
    // work, and marking a bin done on their behalf is how one gets skipped.
    expect(hook).toMatch(/resolveOfflineUserId\(\)/);
    // Un-marked when the replay lands, not only marked when the save is made —
    // `deleteAction` fires the same event on a successful sync.
    expect(hook).toMatch(/"offline-queue-change"/);
  });
});
