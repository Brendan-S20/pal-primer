import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { appOrigin, appUrl } from "@/lib/app-origin";
import { repoRelative } from "./support/repo-paths";

// A CORS preflight may not follow a redirect — the Fetch spec makes it a
// network error — so whichever app host redirects is a host the native app
// cannot talk to at all.
//
// On 2026-08-02 that was the bare host: `app.houndstack.com` 307'd to
// `www.app.houndstack.com`, and the native app pointed at the documented host
// could not call a single server function. The owner removed the CDN rule the
// same day and it reversed: `app.houndstack.com` answers 204 with
// `allow-origin: capacitor://localhost` and the `x-tss-*` expose-headers, and
// `www.app.houndstack.com` 302'd back to it.
//
// On 2026-08-10 the www host stopped resolving entirely — NXDOMAIN, nothing
// there to redirect. See the second half of this file for what that cost and
// the rule it added.
//
// That reversal is the argument for this file. Before it, twenty-four places in
// src/ wrote an app host by hand and disagreed — portal links, unsubscribe URLs,
// invoice pay links and the og:url canonical on one, invite emails, the concerns
// link, the lead-form origin and both Twilio hooks on the other. Which one a URL
// got depended on which file built it, so a change at the CDN fixed some links
// and broke others. Now it is one constant, and one probe that catches the flip.

const SRC = new URL("../src", import.meta.url).pathname;
const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("appOrigin resolves one way", () => {
  it("falls back to the host that actually answers", () => {
    delete process.env.APP_ORIGIN;
    delete process.env.PUBLIC_APP_ORIGIN;
    delete process.env.APP_URL;
    // Not a style preference, and it has changed direction once already.
    // On 2026-08-02 the bare host 307'd to the www one and this asserted www.
    // The owner removed the CDN rule the same day and the bare host now serves
    // while www 302's back to it — so this asserts the bare host. Whichever way
    // it points, the rule is the same: the default is the host that ANSWERS a
    // preflight, because a preflight may not follow a redirect.
    expect(appOrigin()).toBe("https://app.houndstack.com");
  });

  it("prefers APP_ORIGIN, then PUBLIC_APP_ORIGIN, then APP_URL", () => {
    process.env.APP_URL = "https://three.example";
    expect(appOrigin()).toBe("https://three.example");

    process.env.PUBLIC_APP_ORIGIN = "https://two.example";
    expect(appOrigin()).toBe("https://two.example");

    process.env.APP_ORIGIN = "https://one.example";
    expect(appOrigin()).toBe("https://one.example");
  });

  it("reads PUBLIC_APP_ORIGIN because the Twilio hooks already depend on it", () => {
    // That one is security-critical: the canonical URL rebuilt for signature
    // validation has to match what Twilio signed, character for character.
    // Ignoring a variable a deployment already sets would break signatures.
    delete process.env.APP_ORIGIN;
    delete process.env.APP_URL;
    process.env.PUBLIC_APP_ORIGIN = "https://hooks.example";
    expect(appOrigin()).toBe("https://hooks.example");
  });

  it("strips trailing slashes so joins do not double up", () => {
    process.env.APP_ORIGIN = "https://one.example///";
    expect(appOrigin()).toBe("https://one.example");
    expect(appUrl("/portal")).toBe("https://one.example/portal");
  });

  it("joins a path with or without a leading slash", () => {
    process.env.APP_ORIGIN = "https://one.example";
    expect(appUrl("/auth")).toBe("https://one.example/auth");
    expect(appUrl("auth")).toBe("https://one.example/auth");
    expect(appUrl()).toBe("https://one.example/");
  });

  it("does not throw when process is absent", () => {
    // Called from route components that also render in the browser bundle.
    const saved = globalThis.process;
    try {
      // @ts-expect-error - deliberately simulating a browser global scope
      delete globalThis.process;
      expect(() => appOrigin()).not.toThrow();
    } finally {
      globalThis.process = saved;
    }
  });
});

/**
 * Comments stripped, so a doc block naming a host is not a finding — the
 * assertion is about code, and only code.
 *
 * String-aware, because the naive version was not and it silently disabled this
 * entire check. A regex that deletes from the first double-slash to end of line
 * treats the slashes inside "https://app.houndstack.com" as the start of a
 * comment and eats the rest of the line — so the one string this file exists to
 * forbid was the one string it could never see. A mutation putting the
 * hardcoded host back into portal-links.server.ts passed cleanly, which is the
 * only reason it was found.
 *
 * Template literals are treated as plain strings up to the next unescaped
 * backtick. A `${...}` holding a comment would confuse it; nothing in this
 * codebase does that, and the failure direction would be a false positive,
 * which is loud rather than silent.
 */
function tsCode(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i];
      out += src[i];
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

function tsFiles(dir: string): string[] {
  return allFiles(dir).filter((f) => /\.(ts|tsx)$/.test(f));
}

/** Every readable file under `dir`, whatever its extension — the documented-URL
 *  rule below has to see .sql and .md as well as .ts. */
function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allFiles(full));
    else out.push(full);
  }
  return out;
}

describe("nothing writes the host by hand", () => {
  const files = tsFiles(SRC).filter((f) => !f.endsWith("/lib/app-origin.ts"));

  it("finds the source files at all", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const file of files) {
    const code = tsCode(readFileSync(file, "utf8"));
    if (!/houndstack\.com/.test(code)) continue;
    const short = file.slice(file.indexOf("src/"));
    it(`${short} does not hardcode an app host`, () => {
      expect(
        code,
        `${short} writes an app host into code. Use appOrigin() or appUrl() from ` +
          `@/lib/app-origin — the bare host 307-redirects, and a hardcoded copy is ` +
          `how twenty-four call sites came to disagree about where this app lives.`,
      ).not.toMatch(/https:\/\/(www\.)?app\.houndstack\.com/);
    });
  }
});

/**
 * The other way a host spreads, which the rule above deliberately does not see.
 *
 * `tsCode()` strips comments on purpose — a doc block that mentions a host in
 * passing is not a defect, and failing on prose is how a check gets switched
 * off. That reasoning is still right for prose. It is wrong for one specific
 * shape, and 2026-08-10 is the day that became clear.
 *
 * `src/routes/api/public/leads.ts` opened with the line
 *
 *     // POST https://www.app.houndstack.com/api/public/leads
 *
 * which is not prose. It is an instruction: it names the URL an integrator
 * pastes into their own site or a provider's dashboard. It had been wrong for
 * some time and no test could see it, because it is a comment.
 *
 * What that costs was demonstrated the same week by the Resend suppression
 * webhook, which had been configured against `www.app.houndstack.com` while
 * that host still answered. When the DNS record went away the endpoint began
 * failing with no HTTP status at all — a connect error — Resend disabled it
 * after repeated failures, and it stayed disabled for eight days. Bounces and
 * spam complaints recorded nowhere; `suppressed_emails` frozen at 14 rows with
 * its newest dated 2026-08-02, while the app went on sending mail normally.
 * Nothing in the app was broken, so nothing in the app complained.
 *
 * So: a comment naming a host is still fine. A comment naming a host in
 * CALLABLE position — an HTTP verb followed by an absolute URL — is a fact
 * about where this app lives, and has to agree with the one constant that says
 * where this app lives.
 *
 * Deliberately narrow. It matches `VERB https://…` at the start of a comment
 * line and nothing else, which repo-wide is one line today. It does not touch
 * the marketing hosts (`houndstack.com`, `www.houndstack.com`) — a different
 * property with a different origin — and it does not touch prose that happens
 * to contain a URL, including the worked example in
 * `src/lib/server-fn-origin.ts` of a value that deliberately does NOT work.
 */
describe("a URL written for someone else to call names the right host", () => {
  const ENDPOINT_COMMENT =
    /^[ \t]*(?:\/\/|--|#|\*)[ \t]*(GET|POST|PUT|PATCH|DELETE|OPTIONS)[ \t]+(https?:\/\/[^\s)"'`]+)/gim;

  const ROOT = new URL("..", import.meta.url).pathname;

  const documented = (): { file: string; line: number; verb: string; url: string }[] => {
    const out: { file: string; line: number; verb: string; url: string }[] = [];
    for (const dir of ["src", "scripts", "supabase", "docs"]) {
      let files: string[];
      try {
        files = allFiles(join(ROOT, dir));
      } catch {
        continue; // a directory that does not exist is not a failure
      }
      for (const file of files) {
        let text: string;
        try {
          text = readFileSync(file, "utf8");
        } catch {
          continue; // unreadable or binary
        }
        for (const m of text.matchAll(ENDPOINT_COMMENT)) {
          out.push({
            file: repoRelative(file, ROOT),
            line: text.slice(0, m.index).split("\n").length,
            verb: m[1],
            url: m[2],
          });
        }
      }
    }
    return out;
  };

  it("finds the documented endpoints at all, rather than passing on none", () => {
    // If this drops to zero the rule below is vacuous. One line matches today;
    // the assertion is that the scan still works, not that the count is fixed.
    expect(documented().length).toBeGreaterThanOrEqual(1);
  });

  it("points every one of them at the host this app actually answers on", () => {
    delete process.env.APP_ORIGIN;
    delete process.env.PUBLIC_APP_ORIGIN;
    delete process.env.APP_URL;
    const expected = new URL(appOrigin()).host;

    const wrong = documented()
      .filter((d) => /houndstack\.com/.test(d.url))
      .filter((d) => {
        const host = new URL(d.url).host;
        // The marketing site is a separate property, not this app.
        if (host === "houndstack.com" || host === "www.houndstack.com") return false;
        return host !== expected;
      })
      .map((d) => `${d.file}:${d.line}  ${d.verb} ${d.url}`);

    expect(
      wrong,
      wrong.length
        ? `these lines tell an integrator to call a host this app does not answer on ` +
            `(expected ${expected}).\nA wrong host here does not break a test or a build — ` +
            `it gets pasted into someone else's\nconfiguration and fails there, with no status ` +
            `code and nothing on this side reporting it:\n` +
            wrong.map((w) => `  ${w}`).join("\n")
        : "",
    ).toEqual([]);
  });
});

describe("the script and the module agree on the default", () => {
  it("check-app-origin.mjs uses the same fallback as appOrigin()", () => {
    // The script is plain node and cannot import the TS module, so the constant
    // is written twice. Two copies of one fact is the pattern this whole change
    // exists to remove, so the duplication is at least pinned: if someone
    // changes the module's default when the CDN redirect is fixed and forgets
    // the script, the script would keep probing the old host and keep passing.
    const src = readFileSync(
      new URL("../scripts/check-app-origin.mjs", import.meta.url).pathname,
      "utf8",
    );
    const m = /const FALLBACK = "([^"]+)"/.exec(src);
    expect(m, "check-app-origin.mjs no longer declares a FALLBACK constant").toBeTruthy();

    delete process.env.APP_ORIGIN;
    delete process.env.PUBLIC_APP_ORIGIN;
    delete process.env.APP_URL;
    expect(m![1]).toBe(appOrigin());
  });

  it("probes the path the native app actually calls", () => {
    const src = readFileSync(
      new URL("../scripts/check-app-origin.mjs", import.meta.url).pathname,
      "utf8",
    );
    // A preflight against a path that is not under the CORS prefix would answer
    // without CORS headers and the check would fail for the wrong reason.
    expect(src).toMatch(/PROBE_PATH = "\/_serverFn\//);
  });
});
