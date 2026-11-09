// #764, acceptance criterion 6: "A health check or CI job fails when any
// configured auth hook host does not resolve (prove it with a deliberately bad
// host in a test)."
//
// For three months the Supabase Auth Send Email hook pointed at
// www.app.houndstack.com, which stopped resolving on 2026-08-10, and every
// password reset died as 422 hook_timeout_after_retry. Nothing in the repo
// could see it, because the hook URI is a remote Auth setting.
// scripts/check-auth-hook-hosts.mjs is the check; this proves it fails on the
// host that actually broke, on a host that can never exist, and that it does
// not print a secret while doing so.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkHookUri,
  hookUrisFromEnv,
  redactUri,
  DEFAULT_SEND_EMAIL_HOOK_URI,
} from "../scripts/check-auth-hook-hosts.mjs";
import { appOrigin } from "@/lib/app-origin";

const SCRIPT = fileURLToPath(new URL("../scripts/check-auth-hook-hosts.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// RFC 6761: `.invalid` is guaranteed never to resolve, on any resolver, online
// or not. That makes it the deterministic bad host.
const NEVER = "https://this-host-does-not-exist.houndstack.invalid/email/auth/webhook";
// The host that actually broke prod.
const THE_ONE_THAT_BROKE = "https://www.app.houndstack.com/email/auth/webhook";

const resolves = async () => [{ address: "185.158.133.1", family: 4 }];
const nxdomain = async () => {
  throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
};
const answers =
  (status: number, headers: Record<string, string> = {}) =>
  async () =>
    new Response(null, { status, headers });

describe("a hook host that does not resolve fails the check", () => {
  it("fails on NXDOMAIN and names the host", async () => {
    const r = await checkHookUri(THE_ONE_THAT_BROKE, { lookup: nxdomain, probe: answers(401) });
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toMatch(/www\.app\.houndstack\.com does not resolve \(ENOTFOUND\)/);
  });

  it("fails on a lookup that returns no address", async () => {
    const r = await checkHookUri(DEFAULT_SEND_EMAIL_HOOK_URI, { lookup: async () => [] });
    expect(r.problems).toEqual([expect.stringMatching(/resolved to no address/)]);
  });

  it("fails with REAL dns on a host that can never exist", async () => {
    const r = await checkHookUri(NEVER, { dnsOnly: true });
    expect(r.problems).toEqual([
      expect.stringMatching(/this-host-does-not-exist\.houndstack\.invalid does not resolve/),
    ]);
  });

  it("the CLI exits non-zero, loudly, and prints no secret", () => {
    const secret = "v1,whsec_DO_NOT_PRINT_THIS_6f2a";
    let code = 0;
    let out = "";
    try {
      execFileSync("node", [SCRIPT, "--dns-only"], {
        cwd: ROOT,
        env: {
          ...process.env,
          // userinfo + query are where a careless URI would carry a secret
          AUTH_HOOK_URIS: `https://user:${encodeURIComponent(secret)}@this-host-does-not-exist.houndstack.invalid/email/auth/webhook?token=${encodeURIComponent(secret)}`,
          SEND_EMAIL_HOOK_SECRET: secret,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { status: number; stdout?: string; stderr?: string };
      code = e.status;
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    expect(code).toBe(1);
    expect(out).toMatch(
      /✗ auth hook https:\/\/this-host-does-not-exist\.houndstack\.invalid\/email\/auth\/webhook is NOT reachable/,
    );
    expect(out).not.toContain("whsec_");
    expect(out).not.toContain("DO_NOT_PRINT");
    expect(out).not.toContain("token=");
  });

  it("checks EVERY configured hook, and one bad one fails the run", () => {
    let code = 0;
    try {
      execFileSync("node", [SCRIPT, "--dns-only"], {
        cwd: ROOT,
        env: { ...process.env, AUTH_HOOK_URIS: `${DEFAULT_SEND_EMAIL_HOOK_URI}, ${NEVER}` },
        stdio: "ignore",
      });
    } catch (err) {
      code = (err as { status: number }).status;
    }
    expect(code).toBe(1);
  });
});

describe("the route has to answer, not just the host", () => {
  it("401 to an unsigned POST is healthy: the route is alive", async () => {
    const r = await checkHookUri(DEFAULT_SEND_EMAIL_HOOK_URI, {
      lookup: resolves,
      probe: answers(401),
    });
    expect(r.problems).toEqual([]);
  });

  it.each([404, 405])("%i means there is no webhook at that path", async (s) => {
    const r = await checkHookUri(DEFAULT_SEND_EMAIL_HOOK_URI, {
      lookup: resolves,
      probe: answers(s),
    });
    expect(r.problems).toEqual([expect.stringMatching(/no webhook at this path/)]);
  });

  it("5xx (a missing hook secret answers 500) fails", async () => {
    const r = await checkHookUri(DEFAULT_SEND_EMAIL_HOOK_URI, {
      lookup: resolves,
      probe: answers(500),
    });
    expect(r.problems).toEqual([expect.stringMatching(/answered 500/)]);
  });

  it("a redirect fails, because GoTrue does not follow one", async () => {
    const r = await checkHookUri(DEFAULT_SEND_EMAIL_HOOK_URI, {
      lookup: resolves,
      probe: answers(307, { location: "https://elsewhere.example/x?sig=secret" }),
    });
    expect(r.problems).toEqual([
      expect.stringMatching(/redirects \(307 → https:\/\/elsewhere\.example\/x\)/),
    ]);
    expect(r.problems[0]).not.toContain("sig=");
  });

  it("a connection error fails", async () => {
    const r = await checkHookUri(DEFAULT_SEND_EMAIL_HOOK_URI, {
      lookup: resolves,
      probe: async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
    });
    expect(r.problems).toEqual(["the route did not answer (ECONNREFUSED)"]);
  });

  it("plain http fails", async () => {
    const r = await checkHookUri("http://app.houndstack.com/email/auth/webhook", {
      lookup: resolves,
      probe: answers(401),
    });
    expect(r.problems).toEqual(["the hook URI is http, not https"]);
  });
});

describe("what it checks by default", () => {
  it("defaults to the send-email webhook on the app origin, never the www host", () => {
    const u = new URL(DEFAULT_SEND_EMAIL_HOOK_URI);
    delete process.env.APP_ORIGIN;
    delete process.env.PUBLIC_APP_ORIGIN;
    delete process.env.APP_URL;
    expect(u.origin).toBe(appOrigin());
    expect(u.pathname).toBe("/email/auth/webhook");
    expect(u.hostname.startsWith("www.")).toBe(false);
    // and that route is real
    expect(
      readFileSync(
        fileURLToPath(new URL("../src/routes/email/auth/webhook.ts", import.meta.url)),
        "utf8",
      ),
    ).toMatch(/createFileRoute\("\/email\/auth\/webhook"\)/);
  });

  it("reads AUTH_HOOK_URIS, then AUTH_SEND_EMAIL_HOOK_URI, then the default", () => {
    expect(hookUrisFromEnv({ AUTH_HOOK_URIS: "https://a.example/x, https://b.example/y" })).toEqual(
      ["https://a.example/x", "https://b.example/y"],
    );
    expect(hookUrisFromEnv({ AUTH_SEND_EMAIL_HOOK_URI: "https://c.example/z" })).toEqual([
      "https://c.example/z",
    ]);
    expect(hookUrisFromEnv({})).toEqual([DEFAULT_SEND_EMAIL_HOOK_URI]);
  });

  it("redaction drops userinfo, query and fragment", () => {
    expect(redactUri("https://u:p@h.example/a/b?k=v#f")).toBe("https://h.example/a/b");
    expect(redactUri("not a url")).toBe("<unparseable hook URI>");
  });

  it("is wired into local CI and the workflow", () => {
    const read = (p: string) =>
      readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
    expect(read("scripts/ci-local.sh")).toContain("scripts/check-auth-hook-hosts.mjs");
    expect(read(".github/workflows/ci.yml")).toContain("scripts/check-auth-hook-hosts.mjs");
    expect(JSON.parse(read("package.json")).scripts["check:auth-hooks"]).toBe(
      "node scripts/check-auth-hook-hosts.mjs",
    );
  });
});
