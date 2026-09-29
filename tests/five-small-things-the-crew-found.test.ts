// Step one of the eleven-reviewer audit: the fixes that are one line or one
// file. Grouped because they share a shape — none of them is a missing
// feature, every one is a small piece of code doing almost the right thing,
// and each was invisible from the outside because the failure looks like
// normal operation.
//
//   close button      16x16 target on every dialog and sheet in the app
//   failed drag       the optimistic move survives the failure
//   frozen board      the optimistic move also survives SUCCESS
//   reminder texts    "scheduled for 2026-08-12", to the customer
//   add-on confirm    the condition short-circuits the wrong way round
//   photo kind        the picker keeps its last value, so the completion
//                     photo gets filed as a Before
//
// One correction to the report, since it drove the ordering: the photo bug
// was written up as silently blocking a tech. It is not silent — the Complete
// button carries a title, and a line under the row says "Take a completion
// photo to finish this visit." What is silent is the CAUSE: the tech did take
// one, and nothing on screen says it was filed under the wrong kind. The fix
// is the same; the description was stronger than the code.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { formatDay } from "@/lib/format";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Comment lines stripped. Every fix below is documented in a comment that
 *  quotes the code it replaced, so a `not.toMatch` run against raw source
 *  would fail on the explanation of the fix rather than the defect. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

describe("every dialog and sheet closes with a thumb-sized target", () => {
  const UI = join(root, "src/components/ui");

  /** Every `<Something.Close className="…">` under ui/, by file. */
  const closeButtons = (): Array<[string, string]> => {
    const found: Array<[string, string]> = [];
    for (const f of readdirSync(UI)) {
      if (!f.endsWith(".tsx")) continue;
      const src = readFileSync(join(UI, f), "utf8");
      for (const m of src.matchAll(/[A-Za-z]+Primitive\.Close className="([^"]+)"/g)) {
        found.push([f, m[1]]);
      }
    }
    return found;
  };

  it("finds the close buttons where the report said they were", () => {
    // The claim was "one edit to two files fixes it everywhere". That is only
    // true if there are exactly two, which is worth checking rather than
    // believing — a third would mean a third of the app stayed broken.
    expect(
      closeButtons()
        .map(([f]) => f)
        .sort(),
    ).toEqual(["dialog.tsx", "sheet.tsx"]);
  });

  it("sizes the button, not just the icon inside it", () => {
    // The button had no size class at all, so it collapsed to the 16px glyph:
    // 13% of the area a thumb needs, on a product whose primary surface is a
    // phone in a truck.
    for (const [file, cls] of closeButtons()) {
      const tokens = cls.split(/\s+/);
      expect(tokens, file).toEqual(expect.arrayContaining(["h-11", "w-11"]));
      // Centred, or the 44px box would hang the glyph off its top-left.
      expect(tokens, file).toEqual(
        expect.arrayContaining(["flex", "items-center", "justify-center"]),
      );
    }
  });

  it("keeps the glyph at 16px, so nothing looks different", () => {
    // Growing the icon to fill 44px would be a redesign. The target grew; the
    // drawing did not.
    for (const f of ["dialog.tsx", "sheet.tsx"]) {
      const src = readFileSync(join(UI, f), "utf8");
      // Anchored on the className, not on "Primitive.Close" — the bare name
      // also appears in the `const DialogClose = DialogPrimitive.Close` line
      // at the top of the file.
      const close = src.slice(src.search(/[A-Za-z]+Primitive\.Close className="/));
      expect(close.slice(0, 600), f).toMatch(/<X className="h-4 w-4 shrink-0" \/>/);
    }
  });
});

describe("the routes board stops lying about where a visit went", () => {
  const routes = read("src/routes/_authenticated/routes.tsx");
  const onDragEnd = routes.slice(
    routes.indexOf("async function onDragEnd"),
    routes.indexOf("const activeVisit"),
  );

  it("drops the optimistic move when the reassign fails", () => {
    // Previously: toast and nothing else. The card stayed in the lane it
    // never reached, so the board and the database disagreed about who owns
    // the visit for the rest of the session.
    const failure = onDragEnd.slice(onDragEnd.indexOf("} catch (err) {"));
    expect(codeOnly(failure)).toMatch(/setLocalColumns\(null\);/);
  });

  it("and drops it after a successful one too, once the refetch has landed", () => {
    expect(routes).toMatch(/const settle = async \(\) => \{/);
    // Awaited, then cleared — in that order. Clearing first would show the
    // pre-drag order for however long the refetch takes.
    const settle = routes.slice(routes.indexOf("const settle = async () => {"));
    const settleBody = settle.slice(0, settle.indexOf("};") + 2);
    expect(settleBody).toMatch(/await qc\.invalidateQueries/);
    expect(settleBody.indexOf("await qc.invalidateQueries")).toBeLessThan(
      settleBody.indexOf("setLocalColumns(null)"),
    );
  });

  it("uses it on both branches — same-lane reorder and cross-lane move", () => {
    expect(onDragEnd.match(/await settle\(\);/g)).toHaveLength(2);
  });

  it("no longer fires the bare invalidate that left the snapshot standing", () => {
    // The old ending. It refetched, the query updated, and `columns` went on
    // returning the frozen snapshot, so nothing on the board moved while the
    // map and the warnings banner beside it showed the new data.
    expect(codeOnly(onDragEnd)).not.toMatch(
      /qc\.invalidateQueries\(\{ queryKey: \["visits", day\] \}\);/,
    );
  });
});

describe("reminder texts read like a person wrote them", () => {
  const messages = read("src/lib/messages.functions.ts");

  it("formats the date instead of pasting the column", () => {
    expect(codeOnly(messages)).not.toMatch(/scheduled for \$\{v\.scheduled_on\}/);
    expect(codeOnly(messages)).not.toMatch(/complete for \$\{v\.scheduled_on\}/);
    expect(messages).toMatch(/const day = formatDay\(v\.scheduled_on\);/);
    expect(messages).toMatch(/import \{ formatDay \} from "@\/lib\/format";/);
  });

  it("and formatDay actually changes it", () => {
    // Asserting the call site without asserting the output would pass just as
    // well against a formatter that returned its input.
    expect(formatDay("2026-08-12")).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatDay("2026-08-12")).toContain("Aug 12");
  });

  it("does not slip a day on a date-only string", () => {
    // The reason formatDay anchors at noon. A UTC-parsed midnight rendered in
    // a western timezone is the previous day, which on a reminder text is the
    // difference between a customer being home and not.
    expect(formatDay("2026-01-01")).toContain("Jan 1");
    expect(formatDay("2026-12-31")).toContain("Dec 31");
  });
});

describe("the add-on confirm guards the purchase that charges today", () => {
  const billing = read("src/routes/_authenticated/settings.billing.tsx");
  const buy = billing.slice(billing.indexOf("data?.canSubscribe ? ("));

  it("the short-circuit that skipped the dialog is gone", () => {
    // `a.billing_interval !== "one_time" || (await confirm(…))` — true for
    // every recurring add-on, so the confirm was never evaluated on the one
    // path that takes money immediately.
    expect(codeOnly(billing)).not.toMatch(/billing_interval !== "one_time" \|\|/);
  });

  it("both paths ask, and the answer is what decides", () => {
    expect(buy).toMatch(/const ok = await confirm\(\{/);
    expect(buy).toMatch(/if \(ok\) subscribe\.mutate\(a\.id\);/);
  });

  it("recurring copy says the card is charged today, not on the next invoice", () => {
    // The server adds the subscription item with `proration_behavior:
    // "always_invoice"`, which invoices and auto-charges on the spot. The
    // success toast already said so — after the money moved.
    expect(buy).toMatch(/charged to your card today/);
    expect(buy).toMatch(/one-time \$\{formatUsd\(a\.price_cents\)\} charge on your next invoice/);
  });

  it("quotes the annual figure to an org billed annually", () => {
    // A monthly-priced add-on on an annual plan bills at 12x with no
    // discount. The price on the card already accounts for that; a confirm
    // showing the monthly number would undo it at the last step.
    expect(buy).toMatch(/planInterval === "year" && a\.billing_interval === "month"/);
    expect(buy).toMatch(/formatUsd\(a\.price_cents \* 12\)/);
  });
});

describe("the photo picker returns to the kind that finishes the visit", () => {
  const myDay = read("src/routes/_authenticated/my-day.tsx");
  const upload = myDay.slice(myDay.indexOf("const uploadPhoto = async"));
  const body = upload.slice(0, upload.indexOf("const photos = useMemo"));

  it("resets after a successful upload", () => {
    expect(body).toMatch(/setPhotoKind\("completion"\);/);
  });

  it("resets on the success path only", () => {
    // A failed upload should leave the tech's selection alone — they are
    // about to retry it. The reset belongs after `invalidate()`, not in the
    // `finally` that also runs when the upload threw.
    const fin = body.slice(body.indexOf("} finally {"));
    expect(codeOnly(fin)).not.toMatch(/setPhotoKind/);
  });

  it("and completion is still the default a card opens with", () => {
    expect(myDay).toMatch(/useState<PhotoKind>\("completion"\)/);
  });
});
