// ── EVIDENCE THAT WAS FETCHED AND THROWN AWAY ─────────────────────────────
//
// `platform_admin_audit` has `before_json` and `after_json`. `listTenantAudit`
// selects both. `TenantAuditRow` declares both. The Audit tab on
// /platform/tenants/$id rendered the action name, the actor and the timestamp
// and then dropped them on the floor — so the log could tell you that a tenant
// was suspended, and not for what reason, and not what it was before, which is
// the only question anybody opens an audit log to ask.
//
// Same shape of defect as `humanizeAuditAction` having no caller and
// `invoice_pdf` being selected and rendered nowhere, both fixed on this page
// already: the data was there the whole time and the last three inches of wire
// were missing.
//
// ── WHAT THE LIVE ROWS ACTUALLY LOOK LIKE (checked 2026-08-19) ────────────
//
// 154 rows in production across seven actions. Three facts shaped the design,
// and each of them breaks a diff that was designed against imagined data:
//
//   MOST ROWS HAVE NO BEFORE. 141 of 154 — every impersonation start, enter
//     and stop, every promo capture, the one coupon creation — carry
//     `before_json IS NULL`. Rendering that as an empty object means every
//     field reads as "added", and a create becomes indistinguishable from a
//     change out of nothing. "There was no before" and "the before was empty"
//     are different facts and this file insists they render differently.
//
//   UNCHANGED KEYS ARE THE MAJORITY. The 13 `update_addon_status` rows carry
//     `{id, slug, status, is_active}` on both sides and move exactly one of
//     them. A dump of both blobs makes the reader diff four identical UUIDs by
//     eye to find the one word that moved.
//
//   VALUES ARE NOT ALWAYS SCALARS. `send_announcement_emails` files the whole
//     send result — `{ processed, summary: [ {…}, … ] }` — via
//     `after_json: result as any`. A diff that loops over top-level keys
//     reports "summary changed" and shows nothing.
//
// ── AND ONE THING ABOUT WHERE IT IS RENDERED ──────────────────────────────
//
// Audit rows carry user-supplied strings: organization names, suspension
// reasons a support agent typed, promo codes. This is a platform-admin screen
// showing text from tenants the reader does not control, so every value is
// rendered as text through JSX and never as markup.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffAuditJson, type AuditDiff } from "@/lib/platform-tenant.functions";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(
        t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")
      );
    })
    .join("\n");

const detailRoute = read("src/routes/platform.tenants.$id.tsx");

/** `{path: "before → after"}`, for asserting on a whole diff at once. */
const shown = (d: AuditDiff) =>
  Object.fromEntries(d.rows.map((r) => [r.path, `${r.before ?? "∅"} → ${r.after ?? "∅"}`]));

describe("an absent side is not an empty one", () => {
  it("a row with no before is reported as having no before", () => {
    // The real shape of a `start_impersonation` row.
    const d = diffAuditJson(null, {
      role: "owner",
      target_email: "owner@demo.test",
      target_user_id: "ea15abcf-b959-4f58-a8cd-881d909a0359",
    });
    expect(d.shape).toBe("after-only");
    expect(d.rows).toHaveLength(3);
    // Nothing is claimed to have been "added", because there is nothing to
    // have added it to.
    expect(d.rows.every((r) => r.before === null)).toBe(true);
  });

  it("a row whose before was an empty object is a different result", () => {
    const d = diffAuditJson({}, { role: "owner" });
    expect(d.shape).toBe("both");
    // Here the field genuinely did appear, and the shape says so.
    expect(shown(d)).toEqual({ role: "∅ → owner" });
  });

  it("undefined counts as absent, the way a column that was never written is", () => {
    expect(diffAuditJson(undefined, { a: 1 }).shape).toBe("after-only");
    expect(diffAuditJson({ a: 1 }, undefined).shape).toBe("before-only");
  });

  it("neither side recorded is its own answer, not an empty diff", () => {
    // "Nothing was recorded" and "nothing changed" are different, and a
    // renderer that has to choose a sentence needs to be able to tell.
    const d = diffAuditJson(null, null);
    expect(d.shape).toBe("neither");
    expect(d.rows).toEqual([]);
    expect(d.unchanged).toBe(0);
  });

  it("nothing changed is distinguishable from nothing recorded", () => {
    const same = { id: "75609429-c2c3-4f5d-b122-922e858fc4f4", status: "disabled" };
    const d = diffAuditJson(same, { ...same });
    expect(d.shape).toBe("both");
    expect(d.rows).toEqual([]);
    // The count is what lets the UI say "all 2 recorded fields were identical"
    // instead of falling through to the "nothing was recorded" sentence.
    expect(d.unchanged).toBe(2);
  });
});

describe("what changed, not both blobs", () => {
  it("drops the keys that did not move", () => {
    // A real `update_addon_status` pair, verbatim from production.
    const d = diffAuditJson(
      {
        id: "75609429-c2c3-4f5d-b122-922e858fc4f4",
        slug: "white-label-emails",
        status: "coming_soon",
        is_active: false,
      },
      {
        id: "75609429-c2c3-4f5d-b122-922e858fc4f4",
        slug: "white-label-emails",
        status: "disabled",
        is_active: false,
      },
    );
    expect(shown(d)).toEqual({ status: "coming_soon → disabled" });
    expect(d.unchanged).toBe(3);
  });

  it("reports a removed key as removed rather than as a change to nothing", () => {
    const d = diffAuditJson({ suspended_reason: "card declined" }, {});
    expect(d.rows).toEqual([{ path: "suspended_reason", before: "card declined", after: null }]);
  });

  it("distinguishes a JSON null from an absent key", () => {
    // `suspended_reason: null` is a value the reactivate patch writes on
    // purpose; a missing key is the audit writer not recording the column.
    // Rendering both as "—" would make the two indistinguishable on screen.
    const cleared = diffAuditJson({ suspended_reason: "card declined" }, { suspended_reason: null });
    expect(cleared.rows).toEqual([
      { path: "suspended_reason", before: "card declined", after: "null" },
    ]);
    const dropped = diffAuditJson({ suspended_reason: "card declined" }, {});
    expect(dropped.rows[0].after).toBeNull();
  });

  it("does not confuse the number 1 with the string \"1\", or true with \"true\"", () => {
    expect(shown(diffAuditJson({ v: 1 }, { v: "1" }))).toEqual({ v: "1 → 1" });
    // The values print the same, but the diff still reports them as a change
    // — a silently-equal comparison here would hide a type change in billing
    // data, which is where this table's rows come from.
    expect(diffAuditJson({ v: 1 }, { v: "1" }).rows).toHaveLength(1);
    expect(diffAuditJson({ v: true }, { v: "true" }).rows).toHaveLength(1);
    expect(diffAuditJson({ v: 1 }, { v: 1 }).rows).toHaveLength(0);
  });
});

describe("values are arbitrary JSON, not a flat object of scalars", () => {
  it("walks into nested objects and names the leaf by path", () => {
    const d = diffAuditJson(
      { plan: { name: "Starter", limits: { clients: 50 } } },
      { plan: { name: "Starter", limits: { clients: 200 } } },
    );
    expect(shown(d)).toEqual({ "plan.limits.clients": "50 → 200" });
  });

  it("walks into arrays and names the element by index", () => {
    // The `send_announcement_emails` shape: `{ processed, summary: [ … ] }`.
    const d = diffAuditJson(
      { processed: 2, summary: [{ id: "a", sent: 4 }, { id: "b", sent: 0 }] },
      { processed: 2, summary: [{ id: "a", sent: 4 }, { id: "b", sent: 7 }] },
    );
    expect(shown(d)).toEqual({ "summary[1].sent": "0 → 7" });
  });

  it("treats an empty object or array as a leaf, because becoming empty is a change", () => {
    expect(shown(diffAuditJson({ tags: ["vip"] }, { tags: [] }))).toEqual({
      "tags[0]": "vip → ∅",
      tags: "∅ → []",
    });
    expect(shown(diffAuditJson({ meta: { a: 1 } }, { meta: {} }))).toEqual({
      "meta.a": "1 → ∅",
      meta: "∅ → {}",
    });
  });

  it("an empty record is the whole record, not a nameless field inside it", () => {
    // `{}` and `[]` at the ROOT mean "recorded, and empty" — which `shape` and
    // an empty row list already say. Giving them a leaf of their own puts an
    // unnamed extra line on every diff against them, and pushes the real rows
    // past the size cap. Both containers, because jsonb holds either.
    expect(shown(diffAuditJson({}, { role: "owner" }))).toEqual({ role: "∅ → owner" });
    expect(shown(diffAuditJson([], ["a"]))).toEqual({ "[0]": "∅ → a" });
    expect(shown(diffAuditJson(["a"], []))).toEqual({ "[0]": "a → ∅" });
    expect(diffAuditJson({}, {}).rows).toEqual([]);
    expect(diffAuditJson([], []).rows).toEqual([]);
  });

  it("survives a root that is not an object at all", () => {
    // jsonb holds scalars and arrays too. This must not throw.
    expect(shown(diffAuditJson(1, 2))).toEqual({ "": "1 → 2" });
    expect(diffAuditJson("a", "b").rows[0].path).toBe("");
    expect(shown(diffAuditJson(["a"], ["b"]))).toEqual({ "[0]": "a → b" });
  });

  it("lines up two rows written in different key orders", () => {
    // jsonb does not preserve insertion order, so the same object read back
    // twice can enumerate differently. Sorting the walk is what stops that
    // showing up as spurious changes.
    const d = diffAuditJson({ b: 1, a: 2 }, { a: 2, b: 1 });
    expect(d.rows).toEqual([]);
    expect(d.unchanged).toBe(2);
  });

  it("stops on a pathological blob instead of rendering thousands of lines", () => {
    const wide = Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`k${i}`, i]));
    const d = diffAuditJson({}, wide);
    expect(d.truncated).toBe(true);
    expect(d.rows.length).toBeLessThanOrEqual(400);
  });

  it("stops descending past a sane depth, and says so", () => {
    let deep: unknown = "bottom";
    for (let i = 0; i < 12; i += 1) deep = { down: deep };
    const d = diffAuditJson(null, deep);
    expect(d.truncated).toBe(true);
    // What it does show is still a path, not a crash or an empty result.
    expect(d.rows.length).toBeGreaterThan(0);
  });

  it("caps one very long value rather than letting it set the page width", () => {
    const d = diffAuditJson(null, { blob: "x".repeat(5000) });
    expect(d.rows[0].after!.length).toBeLessThan(400);
    expect(d.rows[0].after!.endsWith("…")).toBe(true);
  });
});

describe("the tab renders it", () => {
  const code = codeOnly(detailRoute);

  it("passes both columns to a view instead of ignoring them", () => {
    // The defect in one assertion: before this, `r.before_json` appeared
    // nowhere in the file that fetched it.
    expect(code).toMatch(/<AuditEvidence before=\{r\.before_json\} after=\{r\.after_json\} \/>/);
    expect(code).toMatch(/diffAuditJson/);
  });

  it("has a distinct sentence for each of the three empty cases", () => {
    // "No detail was recorded", "both sides recorded and both empty", and
    // "recorded and identical" are three different findings, and a reader who
    // sees the same line for all three learns nothing from any of them.
    expect(code).toMatch(/No before\/after detail was recorded for this action\./);
    expect(code).toMatch(/Before and after were both recorded, and both were empty\./);
    expect(code).toMatch(/No field changed/);
    expect(code).toMatch(/this action had no before state/);
  });

  it("renders every value as text, never as markup", () => {
    // Audit rows carry tenant-supplied strings.
    expect(code).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("wraps at 360px instead of scrolling the page sideways", () => {
    const block = code.slice(code.indexOf("function AuditEvidence"));
    // A Stripe id, a UUID and an email have no space to break at, so every
    // value and every path needs `break-all` — this is the exact fault
    // CLAUDE.md describes as only measurable at render time, and the only
    // thing a parser can check is that the escape hatch is present.
    expect((block.match(/break-all/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(block).toMatch(/flex-wrap/);
    // No table, no fixed side-by-side columns: a three-column grid of
    // path / before / after is unreadable at 360px.
    expect(block).not.toMatch(/<Table|grid-cols-3/);
    // And nothing in here may be pinned open at a width.
    expect(block).not.toMatch(/whitespace-nowrap|w-\[\d+px\]/);
  });

  it("keeps the reveal control at a thumb's size", () => {
    const block = code.slice(code.indexOf("function AuditEvidence"));
    expect(block).toMatch(/min-h-11/);
  });

  it("does not dump a hundred rows of a big record into the list", () => {
    const block = code.slice(code.indexOf("function AuditEvidence"));
    expect(block).toMatch(/AUDIT_ROWS_COLLAPSED/);
    expect(block).toMatch(/Show all \$\{diff\.rows\.length\} changes/);
  });
});
