import { describe, expect, it } from "vitest";
import { migrationFiles, readMigration, statements, stripLineComments } from "./support/sql-migrations";

// `cast_roadmap_vote` is granted to `anon`, which is right — the roadmap poll is
// for strangers. From 2026-08-01 to 2026-09-13 the only thing standing between
// that grant and an unbounded INSERT into a production table was
// `UNIQUE (feature, voter_id)`, and the caller supplies both halves of the pair.
//
// 20260913100000 put a per-address rate limit inside the function. That
// migration proves the limit works, end to end, every time it replays — it casts
// 60 votes and a 61st and checks which ones landed. This file exists for the
// thing a replay cannot see: the NEXT migration. `CREATE OR REPLACE FUNCTION` is
// how every function in this repo is amended, and an amendment written from the
// version in somebody's editor silently drops the limit and takes the proof with
// it, because the proof lives in the file that added it and never runs again.
//
// So the rule is about the LAST definition in filename order, not any definition.
const VOTE = "cast_roadmap_vote";
const COUNTS = "roadmap_vote_counts";

/** The final `CREATE [OR REPLACE] FUNCTION public.<name>` statement in the
 *  migration sequence, comments stripped. These files describe the code they
 *  contain in prose at length — the header of 20260913100000 names
 *  `roadmap_vote_throttle` and `cf-connecting-ip` several times each before any
 *  SQL runs — so a text match on the file finds the paragraph, not the function. */
function lastDefinition(name: string): { file: string; body: string } | null {
  let found: { file: string; body: string } | null = null;
  const re = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?${name}"?\s*\(`, "i");
  for (const file of migrationFiles()) {
    for (const st of statements(stripLineComments(readMigration(file)))) {
      if (re.test(st.trim())) found = { file, body: st };
    }
  }
  return found;
}

describe("the roadmap poll's rate limit", () => {
  it("finds function definitions at all, so the rules below are not vacuous", () => {
    // Every assertion here is of the form "the last definition contains X". If
    // `lastDefinition` stopped matching it would return null and each of them
    // would need a null check that reads as a pass. Prove the parser first.
    const vote = lastDefinition(VOTE);
    const counts = lastDefinition(COUNTS);
    expect(vote, `no CREATE FUNCTION for ${VOTE} in any migration`).not.toBeNull();
    expect(counts, `no CREATE FUNCTION for ${COUNTS} in any migration`).not.toBeNull();
    expect(lastDefinition("a_function_no_migration_has_ever_created")).toBeNull();
  });

  it("strips the prose without stripping the code", () => {
    // The tripwire for the failure this repo keeps having: a rule that matches
    // the comment explaining the code rather than the code. `--` comments go;
    // the string literals the function actually reads must survive, because
    // 'cf-connecting-ip' appears in both forms in the same file.
    // Pinned to the file that introduced the limit rather than to whatever is
    // last, because this is a test of the stripper and not of the sequence.
    const file = migrationFiles().find((f) => f.startsWith("20260913100000"));
    expect(file, "the migration that added the rate limit is gone").toBeTruthy();
    const raw = readMigration(file!);
    expect(raw).toContain("-- cf-connecting-ip first");
    const stripped = stripLineComments(raw);
    expect(stripped).not.toContain("-- cf-connecting-ip first");
    expect(stripped).toContain("'cf-connecting-ip'");
    expect(stripped).toContain("roadmap_vote_throttle");
  });

  it(`${VOTE} still consults the throttle`, () => {
    const { file, body } = lastDefinition(VOTE)!;
    expect(
      body,
      `${file} is the last definition of ${VOTE} and it does not touch\n` +
        `roadmap_vote_throttle. Without it the function is an unauthenticated,\n` +
        `unmetered INSERT again: anon holds EXECUTE on it, and both p_feature and\n` +
        `p_voter come from the caller, so UNIQUE (feature, voter_id) bounds nothing.\n` +
        `Amend the limit if it is wrong — do not drop it by rewriting the function\n` +
        `from an older copy.`,
    ).toContain("roadmap_vote_throttle");
  });

  it(`${VOTE} still keys the throttle on the address the gateway vouches for`, () => {
    const { file, body } = lastDefinition(VOTE)!;
    expect(
      body,
      `${file} is the last definition of ${VOTE} and it does not read\n` +
        `cf-connecting-ip. Cloudflare overwrites that header from the TCP peer, so\n` +
        `it is the one part of the request the caller cannot choose. Metering on\n` +
        `anything the caller sets — p_voter, a bare x-forwarded-for read from the\n` +
        `front — is a limit you opt out of with one extra header.`,
    ).toContain("cf-connecting-ip");
  });

  it(`${COUNTS} still bounds what it returns`, () => {
    const { file, body } = lastDefinition(COUNTS)!;
    expect(
      body,
      `${file} is the last definition of ${COUNTS} and it has no LIMIT. It groups\n` +
        `roadmap_votes by feature with no filter, and every visitor to the public\n` +
        `roadmap runs it on page load. One row per distinct slug ever written is\n` +
        `fine while the slugs are the eleven real ones and is the second symptom\n` +
        `of junk the moment they are not.`,
    ).toMatch(/\blimit\b/i);
  });
});
