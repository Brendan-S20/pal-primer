// A permanent button for an occasional question, and a write that must not
// happen because a page was opened.
//
// The routes board carried a full-width dashed "Show weather" button under the
// map, every single day, with a remembered `routes.showWeather` preference
// behind it. On the great majority of days pressing it produced the news that
// it is not going to rain. The owner's words: "let's remove the show weather
// and keep as an icon above or only present when it's supposed to rain or
// snow. Temperature isn't much of a worry."
//
// So the affordance is now CONDITIONAL: an icon, drawn only on a day the
// forecast says brings precipitation, and nothing at all — no button, no
// dashed box, no reserved row — on a day it does not. That is the property
// this file pins, and it is worth pinning because it is invisible in the
// ordinary case. A regression here does not look broken; it looks like the
// button came back, which is exactly how it got there the first time.
//
// ── THE PART THAT IS NOT COSMETIC ─────────────────────────────────────────
//
// Making weather conditional means the PAGE has to know, on load, whether the
// day is risky. There are two functions in this repo that could answer that
// and they are not interchangeable:
//
//   `getWeatherForZones`  (weather.functions.ts) reads zones, counts visits,
//                         and reads/refreshes a shared forecast cache. It
//                         touches no tenant business row. The header's
//                         forecast popover already calls it.
//
//   `analyzeDayWeather`   (weather-day.functions.ts) WRITES. It sets
//                         `weather_flagged` and `weather_note` on the day's
//                         visit rows — that is its entire purpose, and the
//                         reschedule button downstream acts on what it wrote.
//
// If the page reached for the second one to decide whether to draw a button,
// then merely opening the routes board — or arrowing through a week, one
// keystroke per day — would silently flag and unflag visits on days nobody
// asked about. Nothing on screen would say so. The flag is real state that a
// human is meant to have caused.
//
// So the rule is: the analysis stays an explicit action, taken from inside
// the strip, by someone who pressed "Check weather". Two independent things
// have to hold for that, and both are checked below — the route never
// references the writing function, AND the component that does is not even
// mounted until the icon is pressed.
//
// ── WHY THE CLASSIFIER READS TEXT ─────────────────────────────────────────
//
// `assessRisk` in weather.functions.ts owns the thresholds and publishes its
// verdict as `risky` plus human reasons. `hasPrecipitationRisk` does not
// re-derive "will it rain" from `precip_in >= 0.2`; copying those numbers into
// a second file is how two files come to disagree about the weather. It takes
// `risky` as given and only decides which KIND of risk it is, by subtracting
// the two reasons that are not precipitation — wind, and a hard freeze, which
// is temperature and which the owner explicitly set aside.
//
// The cost of that choice is a coupling to wording, so the wording is checked
// here too, against the file that produces it. If somebody rewrites "wind 31
// mph" as "31 mph gusts", the classifier starts calling windy days rainy, and
// the failure lands on this file rather than on a dispatcher wondering why the
// rain icon appears on a clear Tuesday.
//
// The direction of that failure is deliberate. An unrecognised reason counts
// AS precipitation, so a wording change produces a spurious icon rather than a
// missing one. A spurious icon is an annoyance; a missing one is the owner not
// being told it is going to snow, which is the entire point of the feature.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

/** Lazy, and imported per-test rather than at module scope. An import that
 *  throws while this file is being resolved makes vitest report "no tests"
 *  instead of failures — and during a mutation check, a file reporting no
 *  tests looks exactly like a file that passed. Same reasoning as
 *  tests/a-forecast-in-degrees-nobody-here-uses.test.ts. */
const strip = () => import("@/components/WeatherStrip");

const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Both comment forms stripped: `{/* … *\/}` blocks inside JSX, and whole
 *  lines that are `//` or part of a `/* … *\/` run. Every file this touches
 *  now carries long comments ABOUT the thing that was removed — the words
 *  "Show weather" and "showWeather" both appear in prose in routes.tsx — so a
 *  `not.toMatch` against raw source would fail on the explanation instead of
 *  on the defect. */
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

const routes = () => read("src/routes/_authenticated/routes.tsx");
const weatherFns = () => read("src/lib/weather.functions.ts");

describe("rain and snow count, wind and cold do not", () => {
  it("says no when the forecast says the day is fine", async () => {
    const { hasPrecipitationRisk } = await strip();
    // `risky` is the server's verdict. No verdict, no icon — and no reading of
    // the reasons at all, which is what stops an empty-reasons day from
    // falling through to "unrecognised, therefore show it".
    expect(hasPrecipitationRisk({ risky: false, reasons: [] })).toBe(false);
    expect(hasPrecipitationRisk({ risky: false, reasons: ['0.31" rain'] })).toBe(false);
  });

  it("says yes to rain, to a chance of it, and to a thunderstorm", async () => {
    const { hasPrecipitationRisk } = await strip();
    expect(hasPrecipitationRisk({ risky: true, reasons: ['0.31" rain'] })).toBe(true);
    expect(hasPrecipitationRisk({ risky: true, reasons: ["80% chance"] })).toBe(true);
    expect(hasPrecipitationRisk({ risky: true, reasons: ["thunderstorm"] })).toBe(true);
  });

  it("says no to a day whose only problem is wind", async () => {
    const { hasPrecipitationRisk } = await strip();
    // This is the case the owner's sentence rules out. A 31mph dry day is
    // still a risky day and the strip still has something to say about it —
    // but it is not what "only present when it's supposed to rain or snow"
    // asks to be interrupted for.
    expect(hasPrecipitationRisk({ risky: true, reasons: ["wind 31 mph"] })).toBe(false);
  });

  it("says no to a day whose only problem is the temperature", async () => {
    const { hasPrecipitationRisk } = await strip();
    // "Temperature isn't much of a worry." A hard freeze is `temp_max <= 23`
    // with no precipitation term in it at all — cold and clear.
    expect(hasPrecipitationRisk({ risky: true, reasons: ["hard freeze"] })).toBe(false);
    expect(hasPrecipitationRisk({ risky: true, reasons: ["wind 31 mph", "hard freeze"] })).toBe(
      false,
    );
  });

  it("says yes when rain arrives alongside wind", async () => {
    const { hasPrecipitationRisk } = await strip();
    // A wind reason must not be able to SUPPRESS a rain reason. The predicate
    // is "some reason is precipitation", never "every reason is".
    expect(hasPrecipitationRisk({ risky: true, reasons: ["wind 31 mph", '0.44" rain'] })).toBe(
      true,
    );
    expect(hasPrecipitationRisk({ risky: true, reasons: ["hard freeze", "90% chance"] })).toBe(
      true,
    );
  });

  it("treats a reason it does not recognise as precipitation", async () => {
    const { hasPrecipitationRisk } = await strip();
    // The fail-visible direction. A reason added to `assessRisk` later — hail,
    // ice, whatever — shows the icon until somebody classifies it, rather than
    // being silently dropped on the floor.
    expect(hasPrecipitationRisk({ risky: true, reasons: ["freezing rain"] })).toBe(true);
    expect(hasPrecipitationRisk({ risky: true, reasons: ["hail"] })).toBe(true);
  });

  it("is not fooled by a reason that merely contains the word wind", async () => {
    const { hasPrecipitationRisk } = await strip();
    // The wind pattern is anchored at the start for this reason. A substring
    // match would read "rain and wind" as a wind day and hide the icon —
    // failure in the direction that loses the warning.
    expect(hasPrecipitationRisk({ risky: true, reasons: ["rain and wind"] })).toBe(true);
  });
});

describe("the reasons it classifies are the reasons the server writes", () => {
  it("still emits a wind reason that starts with the word wind", () => {
    // If this literal changes shape, `hasPrecipitationRisk` stops recognising
    // wind and every windy day starts showing a rain icon. The classifier
    // cannot see the change; this can.
    expect(weatherFns()).toMatch(/reasons\.push\(`wind \$\{Math\.round\(day\.wind_max\)\} mph`\)/);
  });

  it("still emits 'hard freeze' as its whole reason for a cold day", () => {
    expect(weatherFns()).toMatch(/reasons\.push\("hard freeze"\)/);
  });

  it("still emits the three precipitation reasons", () => {
    // Not to pin the wording — these three are matched by NOT being wind or
    // freeze, so their exact text does not matter to the classifier. What
    // matters is that they remain SEPARATE reasons, because a single merged
    // "bad weather" reason would collapse the distinction the owner asked for.
    const src = weatherFns();
    expect(src).toMatch(/reasons\.push\(`\$\{day\.precip_in\.toFixed\(2\)\}" rain`\)/);
    expect(src).toMatch(/reasons\.push\(`\$\{day\.precip_prob\}% chance`\)/);
    expect(src).toMatch(/reasons\.push\("thunderstorm"\)/);
  });
});

describe("the affordance exists only on a day that carries the risk", () => {
  it("gates the whole block on the forecast, not just on the range", () => {
    // `range === "today"` alone was the old condition, and it was true every
    // day of the year. The forecast term is the change.
    expect(codeOnly(routes())).toMatch(/range === "today" && dayHasPrecipitationRisk && \(/);
  });

  it("computes that flag from the read-only forecast call", () => {
    const src = codeOnly(routes());
    expect(src).toMatch(/import \{ getWeatherForZones \} from "@\/lib\/weather\.functions";/);
    expect(src).toMatch(/const dayHasPrecipitationRisk = useMemo\(/);
    // Through the shared classifier, not a second opinion written inline here.
    expect(src).toMatch(/hasPrecipitationRisk\(d\)/);
    // The zone has to have a working forecast. `status: "error"` or
    // "no_coords" carries an empty `days` array, and a zone that could not be
    // fetched is not evidence of a clear day OR a wet one.
    expect(src).toMatch(/z\.status === "ok"/);
    // And it has to be THIS day. The call asks for one date, but the shape it
    // returns is a list, and a list is exactly the thing that quietly starts
    // answering about tomorrow.
    expect(src).toMatch(/d\.date === day/);
  });

  it("asks only for the single day it is about", () => {
    const src = codeOnly(routes());
    expect(src).toMatch(/getWeatherFn\(\{ data: \{ fromDate: day, toDate: day \} \}\)/);
    // Week and month have no single day for the strip to act on, so the query
    // does not run there at all.
    expect(src).toMatch(/enabled: range === "today"/);
  });

  it("no longer keeps a permanent button or remembers a preference", () => {
    const src = codeOnly(routes());
    // The dashed full-width rectangle. Its twin below it — "Show tech load" —
    // is deliberately untouched and still matches this shape, so the assertion
    // is on the weather block, not on the file.
    const weatherBlock = src.slice(
      src.indexOf('range === "today" && dayHasPrecipitationRisk'),
      src.indexOf("{showLoad ?"),
    );
    expect(weatherBlock.length).toBeGreaterThan(0);
    expect(weatherBlock).not.toMatch(/border-dashed/);
    // Nothing about weather is persisted any more. A remembered "yes, show me
    // weather" means nothing once the control only exists on the days it
    // matters — and the old key is what made the button permanent AND sticky.
    expect(src).not.toMatch(/showWeather/);
    // The block itself reaches for no storage at all. Checked on the block and
    // not on the file, because the panels either side of it — view mode, board
    // layout, density, tech load — legitimately still persist theirs.
    expect(weatherBlock).not.toMatch(/localStorage/);
  });

  it("gives the icon a name and a 44px box", () => {
    const src = codeOnly(routes());
    const block = src.slice(src.indexOf('range === "today" && dayHasPrecipitationRisk'));
    const button = block.slice(0, block.indexOf("</button>"));
    // CLAUDE.md: 16px glyph in a 44px box below md, the ui/dialog.tsx pattern.
    // h-11 is 44px. An icon-only control at 16px is not a target a thumb in a
    // driveway can hit.
    expect(button).toMatch(/h-11 w-11/);
    expect(button).toMatch(/<CloudRain className="h-4 w-4" \/>/);
    // And a name, because there is no text in it. `aria-label` for a screen
    // reader, `title` for a mouse, `aria-expanded` because it toggles.
    expect(button).toMatch(/aria-label=\{weatherOpen \? "Hide weather" : "Show weather"\}/);
    expect(button).toMatch(/aria-expanded=\{weatherOpen\}/);
    // Not hover-only, and not hidden behind one either: it is in the flow of
    // the page at every width, with no `md:` on the element itself.
    expect(button).not.toMatch(/group-hover:/);
    expect(button).not.toMatch(/max-md:hidden/);
  });
});

describe("the strip itself stops reporting the temperature", () => {
  it("keeps precipitation and wind, drops the high", () => {
    // Same sentence, applied one level down: "temperature isn't much of a
    // worry". The per-zone row has to fit a phone, and a number that does not
    // change the answer to "can the crew work today" is a number competing for
    // width with the two that do.
    const src = codeOnly(read("src/components/WeatherStrip.tsx"));
    expect(src).toMatch(/\{z\.precip_prob\}%/);
    expect(src).toMatch(/\{Math\.round\(z\.wind_max\)\} mph/);
    expect(src).not.toMatch(/z\.temp_max\)/);
    expect(src).not.toMatch(/Thermometer/);
  });
});

describe("nothing writes to a visit because a page was opened", () => {
  it("keeps the writing function out of the route entirely", () => {
    const src = codeOnly(routes());
    // Not "is not called in an effect" — not mentioned at all. There is no
    // correct way for this page to reach `analyzeDayWeather` directly, so the
    // absence is the assertion.
    expect(src).not.toMatch(/analyzeDayWeather/);
    expect(src).not.toMatch(/weather-day\.functions/);
  });

  it("does not even mount the component that can write, until asked", () => {
    // The deeper guarantee, and the one that survives someone later adding a
    // prefetch to WeatherStrip: if the strip is not mounted, nothing it could
    // do on mount can happen. It renders behind the toggle, not beside it.
    expect(codeOnly(routes())).toMatch(/\{weatherOpen && <WeatherStrip day=\{day\} \/>\}/);
  });

  it("runs the analysis from a mutation, never from a query or an effect", () => {
    const src = codeOnly(read("src/components/WeatherStrip.tsx"));
    expect(src).toMatch(/mutationFn: \(\) => analyzeFn\(\{ data: \{ day \} \}\)/);
    // A useEffect here would fire the write on mount — which, once the strip
    // is behind a toggle, means "opening the panel flags visits". Pressing
    // "Check weather" is the only thing that may.
    expect(src).not.toMatch(/useEffect/);
    expect(src).not.toMatch(/useQuery\(/);
  });

  it("and the reason that matters: analyzeDayWeather really does write", () => {
    // If this ever stops being true the rules above become theatre, so the
    // premise is checked rather than assumed. Two updates: clear the flag on
    // the day's visits, then set it on the ones the forecast condemns.
    const src = read("src/lib/weather-day.functions.ts");
    expect(src).toMatch(/\.update\(\{ weather_flagged: false, weather_note: null \}\)/);
    expect(src).toMatch(/\.update\(\{ weather_flagged: true/);
  });

  it("while the call the page DOES make touches no business row", () => {
    // getWeatherForZones selects zones, subscriptions and visits, and upserts
    // one thing: the shared forecast cache. Asserted as "the only table it
    // writes is the cache" rather than "it does not write", because it does
    // write, and a reader who greps for `.upsert(` in that file deserves to
    // find this note rather than draw the wrong conclusion.
    const src = weatherFns();
    const writes = [...src.matchAll(/\.from\("([a-z_]+)"\)\s*\n?\s*\.(upsert|insert|delete)\(/g)];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w[1]).toBe("weather_forecast_cache");
    // And the visit-row update lives in the OTHER file, which is the whole
    // distinction this test file is built on.
    expect(src).not.toMatch(/weather_flagged/);
  });
});

describe("the period title is the date picker", () => {
  it("opens a calendar from the heading itself", () => {
    const src = codeOnly(routes());
    // Jobber's shape, and the owner's request: "I also like clicking on the
    // month and it opens the date picker instead of it being separate."
    const h1 = src.slice(src.indexOf('<h1 className="text-2xl font-semibold">'));
    const trigger = h1.slice(0, h1.indexOf("</h1>"));
    expect(trigger).toMatch(/<PopoverTrigger asChild>/);
    expect(trigger).toMatch(/\{heading\}/);
    // The chevron is the only thing on screen that says the title is a
    // control. Without it this is a heading nobody thinks to press.
    expect(trigger).toMatch(/<ChevronDown /);
    expect(trigger).toMatch(/mode="single"/);
    expect(trigger).toMatch(/setDay\(toLocalISO\(picked\)\)/);
    // Local ISO, never `toISOString()` on a picked Date — that is UTC midnight
    // and lands on the previous day west of Greenwich, which on this page
    // means dispatching the wrong day.
    expect(trigger).not.toMatch(/picked\.toISOString\(\)/);
  });

  it("drops the separate date input rather than leaving two of them", () => {
    // Two controls setting the same value, one of them a native date field
    // whose keyboard behaviour the browser decides. The redundant one goes.
    const src = codeOnly(routes());
    // Scoped to the gap BETWEEN the two arrows, which is exactly where it sat.
    // The page still has one other date input — "Move to" in the bulk-select
    // action bar — and that one is a different control doing a different job,
    // so a file-wide `not.toMatch` would be asserting the wrong thing.
    const between = src.slice(src.indexOf("shiftDay(-1)"), src.indexOf("shiftDay(1)"));
    expect(between.length).toBeGreaterThan(0);
    expect(between).not.toMatch(/type="date"/);
    // And the shadcn Input import went with it — nothing else on the page used
    // it, and a leftover import is how a removed control quietly comes back.
    expect(src).not.toMatch(/import \{ Input \} from "@\/components\/ui\/input";/);
  });

  it("keeps the arrows and the Today button, which are the common case", () => {
    // Stepping to the next day is what this toolbar is mostly for; the picker
    // is for the rarer jump. Removing the input must not have taken them.
    const src = codeOnly(routes());
    expect(src).toMatch(/onClick=\{\(\) => shiftDay\(-1\)\}/);
    expect(src).toMatch(/onClick=\{\(\) => shiftDay\(1\)\}/);
    // The org's today since the board stopped asking the device.
    expect(src).toMatch(/disabled=\{day === orgTodayIso\}/);
  });

  it("gives the title and the calendar's days a thumb-sized target", () => {
    const src = codeOnly(routes());
    const h1 = src.slice(src.indexOf('<h1 className="text-2xl font-semibold">'));
    const block = h1.slice(0, h1.indexOf("</h1>"));
    // 2.75rem is 44px, released at md where a pointer is doing the work.
    expect(block).toMatch(/min-h-\[2\.75rem\]/);
    // `md:mouse:min-h-0`, not `md:min-h-0`. The compact desktop row is wanted
    // on a wide screen WITH A MOUSE; an iPad is wide and has a finger, and the
    // bare `md:` cancel put this control back to 40px on every one of them.
    expect(block).toMatch(/md:mouse:min-h-0/);
    // The calendar primitive draws 2rem cells — 32px, under the floor. The
    // documented knob is `--cell-size`, and it has to be overridden on the
    // Calendar element itself: the class is set on the component's own root,
    // so a wrapper setting the variable would be shadowed rather than
    // inherited. Seven 44px columns plus p-3 is 332px, inside a 360px phone.
    expect(block).toMatch(/\[--cell-size:2\.75rem\] md:\[--cell-size:2rem\]/);
  });
});
