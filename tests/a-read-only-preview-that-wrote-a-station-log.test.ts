// The screen says "Preview · read-only". One control on it wrote.
//
// /my-day takes `?staff=<uuid>`, which lets an office role open a technician's
// day. The header badges that state literally — `Preview · read-only` — and the
// card honours it through `canPerformVisit`, which is `!preview && role !==
// "dispatcher"`. Start, complete, skip, the completion photo and the DNA sample
// are all gated on it, and the whole `!preview` branch at the top of the card
// hides the status controls outright.
//
// The Stations button was not gated on anything except the property type:
//
//     {(p?.account_type === "commercial" || p?.has_units) && (
//       <Button onClick={() => setShowStations((s) => !s)}>Stations</Button>
//     )}
//
// and the panel it opens has a Save button wired to `log_station_service`.
//
// ── WHY THIS IS NOT A PERMISSIONS BUG ─────────────────────────────────────
//
// It would be easy to file this as authorization and be wrong. The server
// function reads:
//
//     IF NOT (public.can_write_org(auth.uid(), _org)
//             OR public.is_visit_tech(auth.uid(), _visit_id)) THEN
//       RAISE EXCEPTION 'forbidden';
//
// `can_write_org` is owner / office_manager / dispatcher, so the office user
// doing the previewing is PERMITTED, and the write lands. Nothing is bypassed
// and nothing raises. That is precisely what makes it worth fixing in the UI:
// there is no server-side backstop to catch it, because from the database's
// point of view an office manager logging a station is a legitimate act.
//
// What is wrong is narrower and entirely about honesty. The screen promises to
// write nothing, and then writes a station-service record — a proof-of-service
// row that answers a commercial billing dispute — against a visit belonging to
// somebody else, dated now, with no indication on the record that it came from
// a preview rather than from the tech standing at the bin.
//
// ── WHY THE READ SURVIVES ─────────────────────────────────────────────────
//
// The obvious fix is to gate the button on `canPerformVisit` like its
// neighbours. That is wrong twice. It would hide the panel from a dispatcher,
// who is permitted server-side and for whom `canPerformVisit` is false only
// because start/complete are rejected — a different question. And it would take
// the READ away from the previewing office user, when "has this tech logged the
// bins yet" is one of the things a preview exists to answer.
//
// So `readOnly` is threaded instead: the list, the saved/queued badges and the
// recorded values all render, and only the Save button and the four inputs go.
// The inputs go WITH the button deliberately — a field left editable under a
// heading that says read-only invites someone to type a number that can never
// be saved, which is a second small lie on top of the first.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import en from "@/lib/i18n/locales/en";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Lazy. A read resolved in a describe body turns a missing file into an
// import-time throw, and vitest reports that as "no tests" — which reads as a
// pass. The mutation test for this file stashes src/.
const myDay = () => readFileSync(ROOT + "src/routes/_authenticated/my-day.tsx", "utf8");

/** The body of a named function declaration, brace-matched. Regex cannot do
 *  this: the component contains nested JSX blocks and object literals, and a
 *  lazy match to the next `\n}` stops inside the first of them. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in my-day.tsx`);
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe("a preview badged read-only does not write a station log", () => {
  it("still says read-only, which is the promise being kept", () => {
    // If this label ever goes, the rule below is enforcing a promise the
    // product no longer makes, and should be re-read rather than left running.
    expect(myDay()).toMatch(/Preview\s*·\s*read-only/);
  });

  it("passes the preview flag into the stations panel", () => {
    expect(myDay()).toMatch(/<StationsSubpanel\s+visitId=\{visit\.id\}\s+readOnly=\{preview\}/);
  });

  it("hands it on to every row rather than stopping at the panel", () => {
    const src = myDay();
    // Defaulted false in the SIGNATURE, so every existing caller opts in
    // rather than silently inheriting read-only. `functionBody` starts at the
    // opening brace, so the parameter list is not in it — assert on the
    // declaration itself.
    expect(src).toMatch(/function StationsSubpanel\(\{[^}]*readOnly\s*=\s*false/);
    expect(functionBody(src, "StationsSubpanel")).toMatch(
      /<StationRow[\s\S]*?readOnly=\{readOnly\}/,
    );
  });

  it("removes the save control entirely when read-only, rather than disabling it", () => {
    // Disabling would leave a Save button that looks like the feature is
    // temporarily unavailable. It is not unavailable; it does not apply.
    const body = functionBody(myDay(), "StationRow");
    expect(body).toMatch(/readOnly\s*\?\s*\(/);
    // The words are in lib/i18n (a tech can read them in Spanish).
    expect(body).toMatch(/t\("stations\.readOnly"\)/);
    expect(en.stations.readOnly).toMatch(/Read-only while previewing/);
    // The Save/Update button must sit on the non-readOnly branch.
    const branch = body.slice(body.indexOf("readOnly ? ("));
    const elseAt = branch.indexOf(") : (");
    expect(elseAt, "the read-only ternary has no else branch").toBeGreaterThan(-1);
    expect(branch.slice(elseAt)).toMatch(/existing \? t\("common\.update"\) : t\("common\.save"\)/);
  });

  it("takes the inputs down with it, so nothing invites an unsaveable edit", () => {
    const body = functionBody(myDay(), "StationRow");
    // bags, refill bags, liner checkbox, notes — four inputs, four guards.
    const guarded = body.match(/disabled=\{readOnly\}/g) ?? [];
    expect(
      guarded.length,
      "every input in a read-only station row must be disabled",
    ).toBeGreaterThanOrEqual(4);
  });

  it("leaves the read intact — the panel is why an office user opens a preview", () => {
    const body = functionBody(myDay(), "StationsSubpanel");
    // The query is not conditional on readOnly, and the rows still render.
    expect(body).toMatch(/queryKey:\s*\["visit-stations", visitId\]/);
    expect(body).not.toMatch(/if\s*\(\s*readOnly\s*\)\s*return/);
  });

  it("does not gate the Stations button on canPerformVisit, which would be wrong", () => {
    // canPerformVisit is false for a dispatcher, who IS permitted by
    // log_station_service via can_write_org. Gating on it would remove a real
    // capability to fix a different problem.
    const src = myDay();
    const btn = src.slice(src.indexOf("setShowStations((s) => !s)") - 400);
    expect(btn.slice(0, 400)).not.toMatch(/canPerformVisit/);
  });
});
