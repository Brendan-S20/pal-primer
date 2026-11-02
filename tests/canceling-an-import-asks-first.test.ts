// R2-32 (uxqa-r2-07), the import half: Cancel on an import preview threw it
// away on one tap with no question and no undo. It asks first now. (Revoke on
// an invite already asks; the invite guard rails are in settings.users.tsx and
// users.functions.ts, which another open PR owns.)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IMPORT_CANCEL_CONFIRM } from "@/lib/import-cancel-confirm";

const page = readFileSync(
  join(process.cwd(), "src/routes/_authenticated/imports.$batchId.tsx"),
  "utf8",
);

describe("Cancel on an import preview", () => {
  it("asks before it cancels", () => {
    const body = page.slice(page.indexOf("const doCancel"));
    const ask = body.indexOf("await confirm(IMPORT_CANCEL_CONFIRM)");
    const call = body.indexOf("cancelFn(");
    expect(ask).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(ask);
    expect(body.slice(ask - 10, ask + 60)).toMatch(
      /if \(!\(await confirm\(IMPORT_CANCEL_CONFIRM\)\)\) return;/,
    );
  });
  it("draws the dialog", () => {
    expect(page).toMatch(/useConfirmDialog\(\)/);
    expect(page).toMatch(/\{confirmDialog\}/);
  });
  it("says what is lost and that nothing was imported yet", () => {
    expect(IMPORT_CANCEL_CONFIRM.destructive).toBe(true);
    expect(IMPORT_CANCEL_CONFIRM.description).toMatch(/Nothing from this file has been added yet/);
    expect(IMPORT_CANCEL_CONFIRM.description).toMatch(/cannot be undone/);
    expect(IMPORT_CANCEL_CONFIRM.cancelLabel).not.toBe("Cancel");
  });
});
