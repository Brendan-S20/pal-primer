// The join form accepted an invitation code shorter than any code the
// database has ever been able to issue.
//
// Owner QA, 2026-08-19: "Enterprise/Franchise doesn't fully function
// correctly." This is the linking half of it, and it is the same shape as the
// ZIP fault found the same day — the UI accepted a value the matcher could
// never honour.
//
// ── THE TWO ENDS ──────────────────────────────────────────────────────────
//
//   the database   franchise_link_codes.code carries
//                    CHECK (char_length(code) BETWEEN 8 AND 24)
//                  and create_franchise_link_code mints exactly ten characters
//                  from a Crockford-ish alphabet — digits and capitals, no I,
//                  L, O or U, so it can be read aloud over the phone.
//
//   the product    joinFranchise validated `z.string().trim().min(6).max(24)`
//                  and the Join button was enabled at six characters.
//
// So six and seven characters were accepted, sent, looked up, and could not
// possibly match anything.
//
// ── WHY THAT COSTS MORE THAN IT LOOKS ─────────────────────────────────────
//
// redeem_franchise_link_code answers every failure with ONE message, on
// purpose:
//
//   "That code is not valid. Ask the franchise owner for a new one."
//
// It has to. Distinguishing not-found from expired from already-used would
// turn it into an oracle for guessing codes, and the comment in the migration
// says so. But that means a franchisee who typed six of the ten characters
// they were given is told the code is dead and to go and ask for a new one —
// and the franchise owner, having just watched a perfectly good code fail,
// revokes it and issues another. The cases that can be ruled out without
// asking the database are exactly the cases that must not reach that message.
//
// ── AND THE SPACES ────────────────────────────────────────────────────────
//
// The lookup is `upper(trim(code)) = upper(trim(_code))`, which trims the ENDS
// only. A ten-character code dictated over the phone gets written down as
// "7K2Z Q9M4 XB", and that could not match either — same dead end, same
// misleading answer. Normalizing is safe here and only here because the
// alphabet is closed: a code is digits and capitals and nothing else, so any
// other character is separator rather than content.
//
// Deliberately NOT extended to Crockford's letter folding (O→0, I→1, L→1).
// That would be this layer inventing a match the database does not perform,
// and those letters are absent from the alphabet precisely so that nobody has
// to fold them.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  FRANCHISE_CODE_MAX_LENGTH,
  FRANCHISE_CODE_MIN_LENGTH,
  normalizeFranchiseCode,
} from "@/lib/franchise-membership.functions";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");

const membershipFns = read("src/lib/franchise-membership.functions.ts");
const settingsPage = read("src/routes/_authenticated/settings.franchise.tsx");

/** Every migration, concatenated in replay order. */
function allMigrations(): string {
  const dir = join(ROOT, "supabase/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

describe("the bounds come from the CHECK constraint, not from a guess", () => {
  // Read out of the migration rather than restated here, so the two cannot
  // drift: a test that repeats the number agrees with itself no matter what
  // the table says.
  const m = allMigrations().match(
    /CHECK\s*\(\s*char_length\(code\)\s+BETWEEN\s+(\d+)\s+AND\s+(\d+)\s*\)/i,
  );

  it("finds the constraint that decides this", () => {
    expect(m, "franchise_link_codes.code has no char_length CHECK any more").not.toBeNull();
  });

  it("uses the same minimum the database enforces", () => {
    expect(FRANCHISE_CODE_MIN_LENGTH).toBe(Number(m![1]));
  });

  it("uses the same maximum the database enforces", () => {
    expect(FRANCHISE_CODE_MAX_LENGTH).toBe(Number(m![2]));
  });

  it("still admits the length the generator actually mints", () => {
    // create_franchise_link_code builds its code from generate_series(1, N).
    // If that ever moves outside the bounds above, every code minted after the
    // change is refused by the form before it is ever looked up.
    const gen = allMigrations().match(/INTO _code\s*\n\s*FROM generate_series\(1,\s*(\d+)\)/);
    expect(gen, "could not find the code generator's length").not.toBeNull();
    const minted = Number(gen![1]);
    expect(minted).toBeGreaterThanOrEqual(FRANCHISE_CODE_MIN_LENGTH);
    expect(minted).toBeLessThanOrEqual(FRANCHISE_CODE_MAX_LENGTH);
  });
});

describe("nothing in the product still accepts a six-character code", () => {
  it("does not validate the code against a bare min(6)", () => {
    // The literal defect: z.object({ code: z.string().trim().min(6).max(24) }).
    expect(codeOnly(membershipFns)).not.toMatch(/z\s*\.string\(\)\s*\.trim\(\)\s*\.min\(6\)/);
  });

  it("enables the Join button at the length a code can actually have", () => {
    const code = codeOnly(settingsPage);
    expect(code, "the button's threshold was a literal 6").not.toMatch(
      /code\.trim\(\)\.length < 6/,
    );
    expect(code).toContain("code.length < FRANCHISE_CODE_MIN_LENGTH");
  });

  it("takes its threshold from the same constant the server does", () => {
    // Two numbers in two files is how the button and the validator end up
    // disagreeing about which codes are worth sending.
    expect(settingsPage).toContain("FRANCHISE_CODE_MIN_LENGTH");
  });
});

describe("a code written down the way people write codes down", () => {
  it("survives being read out over the phone in groups", () => {
    expect(normalizeFranchiseCode("7K2Z Q9M4 XB")).toBe("7K2ZQ9M4XB");
  });

  it("survives a hyphen", () => {
    expect(normalizeFranchiseCode("7K2ZQ-9M4XB")).toBe("7K2ZQ9M4XB");
  });

  it("survives being typed in lower case", () => {
    expect(normalizeFranchiseCode("7k2zq9m4xb")).toBe("7K2ZQ9M4XB");
  });

  it("survives a trailing newline from a paste", () => {
    expect(normalizeFranchiseCode("  7K2ZQ9M4XB\n")).toBe("7K2ZQ9M4XB");
  });

  it("does NOT fold the letters the alphabet leaves out", () => {
    // The tempting extra step, and the wrong one: the SQL compares strings, so
    // folding here would make the form claim a match the lookup will not make.
    // No minted code contains any of these, so a value holding one is a typo
    // that should be refused rather than reinterpreted.
    expect(normalizeFranchiseCode("O1IL")).toBe("O1IL");
  });

  it("leaves an already-clean code exactly as it is", () => {
    expect(normalizeFranchiseCode("7K2ZQ9M4XB")).toBe("7K2ZQ9M4XB");
  });

  it("is what the field applies as it is typed", () => {
    // Normalized on change rather than on submit, so the box shows the value
    // that will actually be looked up.
    expect(codeOnly(settingsPage)).toContain("setCode(normalizeFranchiseCode(e.target.value))");
    expect(codeOnly(settingsPage), "the old uppercase-only handler is gone").not.toContain(
      "setCode(e.target.value.toUpperCase())",
    );
  });
});
