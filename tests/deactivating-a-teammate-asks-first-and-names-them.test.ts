import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { staffActiveCopy } from "@/lib/invite-copy";

// #1014: Deactivate had no confirmation and the toast said "Staff updated".
describe("staffActiveCopy", () => {
  it("asks before deactivating, naming the person", () => {
    const c = staffActiveCopy("Sam Rivera", false);
    expect(c.confirm?.title).toBe("Deactivate Sam Rivera?");
    expect(c.confirm?.cancelLabel).toBe("Keep active");
    // "later", not "any time": reactivating is refused when the plan's team is full.
    expect(c.confirm?.description).toBe(
      "They lose access to your business right away. Their visit history stays, and you can reactivate them later.",
    );
    expect(c.toast).toBe("Sam Rivera deactivated");
  });
  it("does not ask before reactivating, and still names them", () => {
    const c = staffActiveCopy("Sam Rivera", true);
    expect(c.confirm).toBeNull();
    expect(c.toast).toBe("Sam Rivera reactivated");
  });
  it("falls back when there is no name", () => {
    expect(staffActiveCopy("  ", false).toast).toBe("this teammate deactivated");
    expect(staffActiveCopy(null, true).toast).toBe("this teammate reactivated");
  });
});

describe("the Users page", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/routes/_authenticated/settings.users.tsx", import.meta.url)),
    "utf8",
  );
  it("no longer toasts the generic 'Staff updated'", () => {
    expect(src).not.toContain('"Staff updated"');
  });
  it("confirms before the deactivate mutation runs, and renders the dialog", () => {
    const click = src.slice(src.indexOf("staffActiveCopy(name, !u.active)"));
    expect(click.indexOf("confirmStaff(")).toBeGreaterThan(-1);
    expect(click.indexOf("confirmStaff(")).toBeLessThan(click.indexOf("toggleActive.mutate"));
    expect(src).toContain("{staffDialog}");
  });
});
