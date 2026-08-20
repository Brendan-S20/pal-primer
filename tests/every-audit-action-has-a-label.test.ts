// The platform audit log rendered actions nobody had written a label for.
//
// ── WHY THIS DRIFTED UNNOTICED ────────────────────────────────────────────
//
// `humanizeAuditAction` falls back to `humanizeEnum` for anything unmapped, so
// a missing label never breaks and never throws — it just reads slightly
// wrong. `end_grace_period` rendered as "End grace period": present tense, in a
// log of things that already happened, sitting directly under "Granted grace
// period". `mirror_plan_to_stripe` rendered with a lower-case "stripe". Nobody
// files a bug for that, so the map fell twenty entries behind the code.
//
// The count, when it was finally measured: the code can write 34 distinct
// actions and AUDIT_ACTION_LABELS had 19, of which several named actions
// nothing writes any more. Two of the unlabelled ones were already in the
// production log — `create_coupon` and `approve_signup_request`.
//
// ── WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────
//
// Every action the code can WRITE must have a label. That is the direction
// that degrades the product, and it is the one a new `audit(...)` call breaks.
//
// The reverse — a label with no writer — is NOT asserted, on purpose.
// `platform_admin_audit` is append-only history: rows written by code that has
// since been deleted still have to render. `approve_signup_request` is exactly
// that case; it is in the production table with a July date and appears in no
// current source file. Asserting the reverse would push somebody to delete the
// label and break the rendering of real rows.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_ACTION_LABELS, humanizeAuditAction } from "@/lib/humanize";

const SRC = join(__dirname, "..", "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    // types.ts is generated and contains the column list, not call sites.
    else if (/\.tsx?$/.test(p) && !p.endsWith("types.ts")) out.push(p);
  }
  return out;
}

/** Every action string this codebase can write to `platform_admin_audit`. */
function actionsTheCodeCanWrite(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    // The `audit(...)` helpers take the action as their 4th argument, which is
    // the first string literal in the call.
    for (const m of src.matchAll(/\baudit\(\s*[^)]*?"([a-z_]+)"/g)) {
      if (!found.has(m[1])) found.set(m[1], file);
    }
    // Some call sites insert into the table directly and name the property.
    if (src.includes("platform_admin_audit")) {
      for (const m of src.matchAll(/\baction:\s*"([a-z_]+)"/g)) {
        if (!found.has(m[1])) found.set(m[1], file);
      }
    }
  }
  return found;
}

describe("every audit action has a label", () => {
  it("finds the call sites at all", () => {
    // If the extractor silently matches nothing, everything below passes and
    // asserts nothing — the failure mode this repo keeps running into.
    const actions = actionsTheCodeCanWrite();
    expect(actions.size).toBeGreaterThanOrEqual(30);
    expect([...actions.keys()]).toContain("suspend_tenant");
    expect([...actions.keys()]).toContain("end_grace_period");
  });

  it("labels every action the code can write", () => {
    const actions = actionsTheCodeCanWrite();
    const unlabelled = [...actions.entries()]
      .filter(([action]) => !(action in AUDIT_ACTION_LABELS))
      .map(([action, file]) => `${action}  (${file.replace(`${SRC}/`, "src/")})`);
    expect(unlabelled, `audit actions with no entry in AUDIT_ACTION_LABELS:\n  ${unlabelled.join("\n  ")}`)
      .toEqual([]);
  });

  it("writes labels in the past tense, like a record of what happened", () => {
    // "End grace period" next to "Granted grace period" is the tell that a
    // label is really the humanizeEnum fallback wearing a label's clothes.
    const present = Object.entries(AUDIT_ACTION_LABELS).filter(
      ([, label]) => /^(Start|End|Create|Delete|Send|Set|Clear|Suspend|Restore|Accept|Revoke|Add|Update|Approve|Mirror|Reassign|Resend|Grant|Void|Issue)\b/.test(label),
    );
    expect(present.map(([k, v]) => `${k}: "${v}"`)).toEqual([]);
  });

  it("still falls back readably for an action it has never seen", () => {
    expect(humanizeAuditAction("something_nobody_mapped")).toBe("Something nobody mapped");
    expect(humanizeAuditAction(null)).toBe("-");
  });
});
