// A server refusal or warning reaches the person who asked (#662).
//
// A server function answers "no" or "yes, but" in three shapes: a thrown
// error (Postgres RAISE text, sometimes "P0001: ..."; or a row-level security
// refusal naming a table), a `{ error }` result, or a result carrying
// `assignWarning`. src/lib/server-outcome.ts turns each into a toast, and the
// four places the audit found saying nothing, or saying "done", use it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type ToastOpts = { description?: string; duration?: number };
const toasts = vi.hoisted(() => [] as Array<{ kind: string; message: string; opts?: ToastOpts }>);
vi.mock("sonner", () => ({
  toast: {
    error: (message: string, opts?: ToastOpts) => toasts.push({ kind: "error", message, opts }),
    warning: (message: string, opts?: ToastOpts) => toasts.push({ kind: "warning", message, opts }),
    success: (message: string, opts?: ToastOpts) => toasts.push({ kind: "success", message, opts }),
  },
}));

const { NOT_ALLOWED_MESSAGE, serverErrorMessage, toastServerError, toastServerOutcome } =
  await import("@/lib/server-outcome");
const { oneOffBookedCopy } = await import("@/lib/one-off-booked");
const { formatDay } = await import("@/lib/format");

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

beforeEach(() => {
  toasts.length = 0;
});

describe("serverErrorMessage", () => {
  it("shows the product's own sentence as it is", () => {
    expect(
      serverErrorMessage(new Error("That client is not in your organization"), { fallback: "x" }),
    ).toBe("That client is not in your organization");
  });

  it("drops a P0001 prefix and keeps the RAISE text (invite accept)", () => {
    const e = new Error("P0001: This invitation is for ana@example.com. Sign in as that address.");
    expect(serverErrorMessage(e, { fallback: "x" })).toBe(
      "This invitation is for ana@example.com. Sign in as that address.",
    );
  });

  it("reads a Postgrest-shaped object, not only an Error", () => {
    expect(
      serverErrorMessage({ code: "P0001", message: "Invitation already used" }, { fallback: "x" }),
    ).toBe("Invitation already used");
  });

  it("turns a row-level security refusal into words, or the caller's words", () => {
    const rls = new Error('new row violates row-level security policy for table "subscriptions"');
    expect(serverErrorMessage(rls, { fallback: "x" })).toBe(NOT_ALLOWED_MESSAGE);
    expect(serverErrorMessage(rls, { fallback: "x", refused: "No plans for you." })).toBe(
      "No plans for you.",
    );
    expect(serverErrorMessage({ code: "42501", message: "denied" }, { fallback: "x" })).toBe(
      NOT_ALLOWED_MESSAGE,
    );
  });

  it("uses the fallback for an empty message or a validator's issue list", () => {
    expect(serverErrorMessage(new Error(""), { fallback: "Could not save." })).toBe(
      "Could not save.",
    );
    const issues = JSON.stringify([{ code: "invalid_type", path: ["x"], message: "Required" }]);
    expect(serverErrorMessage(new Error(issues), { fallback: "Could not save." })).toBe(
      "Could not save.",
    );
  });
});

describe("toastServerError", () => {
  it("is an error toast with the readable message", () => {
    toastServerError(new Error("P0001: Already a member of another business"), { fallback: "x" });
    expect(toasts).toEqual([
      { kind: "error", message: "Already a member of another business", opts: undefined },
    ]);
  });
});

describe("toastServerOutcome", () => {
  it("result.error is an error, and the caller is told it failed", () => {
    const kind = toastServerOutcome(
      { error: "That day is not a work day" },
      { success: "Booked.", fallback: "x" },
    );
    expect(kind).toBe("error");
    expect(toasts).toEqual([
      { kind: "error", message: "That day is not a work day", opts: undefined },
    ]);
  });

  it("result.error as an object is read too", () => {
    toastServerOutcome({ error: { message: "Refused" } }, { success: "Booked.", fallback: "x" });
    expect(toasts[0]).toMatchObject({ kind: "error", message: "Refused" });
  });

  it("assignWarning is a warning that still says what was done", () => {
    const kind = toastServerOutcome(
      { assignWarning: "Ana is off on that day" },
      { success: "Visit booked for Mon, Nov 9, but not assigned to Ana.", fallback: "x" },
    );
    expect(kind).toBe("warning");
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("warning");
    expect(toasts[0].message).toBe("Visit booked for Mon, Nov 9, but not assigned to Ana.");
    expect(toasts[0].opts?.description).toBe("Ana is off on that day");
  });

  it("a caller's warning and the server's are said together", () => {
    toastServerOutcome(
      { assignWarning: "Ana is off." },
      { success: "Booked.", warnings: ["It moved.", null, false, ""], fallback: "x" },
    );
    expect(toasts[0].opts?.description).toBe("It moved. Ana is off.");
  });

  it("nothing to say is a plain success", () => {
    expect(toastServerOutcome({ assignWarning: null }, { success: "Booked.", fallback: "x" })).toBe(
      "success",
    );
    expect(toasts).toEqual([{ kind: "success", message: "Booked.", opts: undefined }]);
  });
});

describe("the one-off dialog's toast", () => {
  const SAT = "2099-11-07";
  const MON = "2099-11-09";

  it("names the date and the tech on a clean booking", () => {
    const copy = oneOffBookedCopy({
      requestedOn: MON,
      result: { scheduledOn: MON, assigned: true, assignWarning: null },
      assigneeName: "Ana Ruiz",
    });
    toastServerOutcome({ assignWarning: null }, { ...copy, fallback: "x" });
    expect(toasts).toEqual([
      {
        kind: "success",
        message: `Visit booked for ${formatDay(MON)} with Ana Ruiz.`,
        opts: undefined,
      },
    ]);
  });

  it("says unassigned when nobody was picked", () => {
    const copy = oneOffBookedCopy({
      requestedOn: MON,
      result: { scheduledOn: MON, assigned: false, assignWarning: null },
      assigneeName: null,
    });
    expect(copy.success).toBe(`Visit booked for ${formatDay(MON)}, unassigned.`);
    expect(copy.warnings).toEqual([]);
  });

  it("a Saturday that became Monday is said, not hidden", () => {
    const result = { scheduledOn: MON, assigned: true, assignWarning: null };
    const copy = oneOffBookedCopy({ requestedOn: SAT, result, assigneeName: "Ana Ruiz" });
    expect(toastServerOutcome(result, { ...copy, fallback: "x" })).toBe("warning");
    expect(toasts[0].message).toBe(`Visit booked for ${formatDay(MON)} with Ana Ruiz.`);
    expect(toasts[0].opts?.description).toContain(`${formatDay(SAT)} is not open for booking`);
  });

  it("an away tech's refusal is a warning naming who was not assigned, and why", () => {
    const result = {
      scheduledOn: MON,
      assigned: false,
      assignWarning: "Ana Ruiz is off on 2099-11-09",
    };
    const copy = oneOffBookedCopy({ requestedOn: MON, result, assigneeName: "Ana Ruiz" });
    expect(toastServerOutcome(result, { ...copy, fallback: "x" })).toBe("warning");
    expect(toasts[0].message).toBe(
      `Visit booked for ${formatDay(MON)}, but not assigned to Ana Ruiz.`,
    );
    expect(toasts[0].opts?.description).toBe("Ana Ruiz is off on 2099-11-09");
  });
});

describe("the four call sites go through the helper", () => {
  const code = (p: string) => read(p).replace(/\/\/.*$/gm, "");

  it("the one-off dialog: outcome on success, refusal on error, and it stays open on result.error", () => {
    const src = code("src/components/OneOffVisitDialog.tsx");
    expect(src).toMatch(/toastServerOutcome\(r,/);
    expect(src).toMatch(/=== "error"\) return;/);
    expect(src).toMatch(/onError: \(e: unknown\) => toastServerError\(/);
    expect(src).toMatch(/oneOffBookedCopy\(\{\s*requestedOn: scheduledOn,/);
    expect(src).not.toMatch(/toast\.(success|warning|error)\(/);
  });

  it("the new-client wizard: an RLS refusal at the plan step says what to do", () => {
    const src = code("src/routes/_authenticated/clients.new.tsx");
    // Since #784 the same sentence is also kept under the button, so the
    // wizard builds it with serverErrorMessage and shows it twice, rather
    // than handing the error straight to toastServerError.
    expect(src).toMatch(/onError: \(e\) => \{\s*const opts = \{/);
    expect(src).toMatch(/createFailedMessage\(e, serverErrorMessage\(e, opts\)\)/);
    expect(src).toMatch(/refused: planSkipped/);
  });

  it("invite accept: the refusal is shown through the helper", () => {
    const src = code("src/routes/invite.$token.tsx");
    expect(src).toMatch(/onError: \(e\) =>\s*toastServerError\(e, \{/);
  });
});
