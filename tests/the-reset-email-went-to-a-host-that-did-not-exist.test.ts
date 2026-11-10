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

import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_SEND_EMAIL_HOOK_URI,
  PROD_SUPABASE_REF,
  fetchAuthConfig,
  liveHooks,
  main,
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

  it("fails on a host that can never exist, even behind a resolver that answers everything", async () => {
    // A sinkholing resolver (seen on a reviewer's box: every name -> 198.18.0.1)
    // must not turn the deterministic bad host into a pass. RFC 6761 names are
    // refused before any lookup, so the resolver is never asked.
    let asked = false;
    const sinkhole = async () => {
      asked = true;
      return [{ address: "198.18.0.1", family: 4 }];
    };
    const r = await checkHookUri(NEVER, { lookup: sinkhole, probe: answers(401) });
    expect(asked).toBe(false);
    expect(r.problems).toEqual([
      expect.stringMatching(/this-host-does-not-exist\.houndstack\.invalid is a reserved name/),
    ]);
    for (const host of ["hooks.test", "hooks.example", "app.localhost"]) {
      const x = await checkHookUri(`https://${host}/email/auth/webhook`, { lookup: sinkhole });
      expect(x.problems).toEqual([expect.stringMatching(/reserved name/)]);
    }
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

  it("is a manual tool: no CI job, workflow or npm script runs it (Brendan, 2026-11-09: not needed)", () => {
    const read = (p: string) =>
      readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
    expect(read("scripts/ci-local.sh")).not.toContain("check-auth-hook-hosts");
    expect(read(".github/workflows/ci.yml")).not.toContain("check-auth-hook-hosts");
    expect(JSON.parse(read("package.json")).scripts["check:auth-hooks"]).toBeUndefined();
    expect(
      existsSync(
        fileURLToPath(new URL("../.github/workflows/auth-hook-health.yml", import.meta.url)),
      ),
    ).toBe(false);
  });
});

// ── The live setting, not the assumed one (Product review on #800) ─────────
//
// Probing a default would have stayed green for the whole outage: the code and
// env said app.houndstack.com while the LIVE Auth config said www. These run
// the production path (`--live`) against a MOCKED Management API.

const WWW = "https://www.app.houndstack.com/email/auth/webhook";
const TOKEN = "sbp_TEST_TOKEN_MUST_NOT_BE_PRINTED_91c3";

/** The shape GET /v1/projects/{ref}/config/auth returns, trimmed to hooks. */
const liveConfig = (uri: string, extra: Record<string, unknown> = {}) => ({
  site_url: "https://app.houndstack.com",
  hook_send_email_enabled: true,
  hook_send_email_uri: uri,
  hook_send_email_secrets: "v1,whsec_LIVE_SECRET_IN_RESPONSE",
  hook_custom_access_token_enabled: false,
  hook_custom_access_token_uri: "https://disabled.invalid/x",
  ...extra,
});

function capture() {
  const lines: string[] = [];
  const push = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  return () => lines.join("\n");
}

describe("--live reads the hook Auth is actually configured with", () => {
  afterEach(() => vi.restoreAllMocks());

  it("FAILS when the live config holds the old www URI (the #764 outage)", async () => {
    const out = capture();
    const code = await main(
      ["--live"],
      { SUPABASE_ACCESS_TOKEN: TOKEN },
      {
        fetchAuthConfig: async () => liveConfig(WWW),
        lookup: nxdomain,
        probe: answers(401),
      },
    );
    expect(code).toBe(1);
    expect(out()).toMatch(
      /hook_send_email_uri is https:\/\/www\.app\.houndstack\.com\/email\/auth\/webhook, expected https:\/\/app\.houndstack\.com\/email\/auth\/webhook/,
    );
    expect(out()).toMatch(/www\.app\.houndstack\.com does not resolve \(ENOTFOUND\)/);
  });

  it("fails on the wrong host even when that host resolves and answers", async () => {
    const out = capture();
    const code = await main(
      ["--live"],
      { SUPABASE_ACCESS_TOKEN: TOKEN },
      {
        fetchAuthConfig: async () =>
          liveConfig("https://staging.houndstack.com/email/auth/webhook"),
        lookup: resolves,
        probe: answers(401),
      },
    );
    expect(code).toBe(1);
    expect(out()).toMatch(/expected https:\/\/app\.houndstack\.com\/email\/auth\/webhook/);
  });

  it("passes when the live config holds the expected URI and the route answers 401", async () => {
    const out = capture();
    const code = await main(
      ["--live"],
      { SUPABASE_ACCESS_TOKEN: TOKEN },
      {
        fetchAuthConfig: async () => liveConfig(EXPECTED_SEND_EMAIL_HOOK_URI),
        lookup: resolves,
        probe: answers(401),
      },
    );
    expect(code).toBe(0);
    expect(out()).toMatch(
      /✓ live hook send_email https:\/\/app\.houndstack\.com\/email\/auth\/webhook resolves and answers \(401\)/,
    );
  });

  it.each([
    ["NXDOMAIN", nxdomain, answers(401), /does not resolve/],
    ["5xx", resolves, answers(500), /answered 500/],
    [
      "a redirect off host",
      resolves,
      answers(307, { location: "https://elsewhere.example/" }),
      /redirects/,
    ],
  ])("fails on the expected URI when the route has %s", async (_n, lookup, probe, re) => {
    const out = capture();
    const code = await main(
      ["--live"],
      { SUPABASE_ACCESS_TOKEN: TOKEN },
      {
        fetchAuthConfig: async () => liveConfig(EXPECTED_SEND_EMAIL_HOOK_URI),
        lookup,
        probe,
      },
    );
    expect(code).toBe(1);
    expect(out()).toMatch(re);
  });

  it("fails when the send-email hook is switched off", () => {
    const r = liveHooks(
      liveConfig(EXPECTED_SEND_EMAIL_HOOK_URI, { hook_send_email_enabled: false }),
    );
    expect(r.problems).toEqual([expect.stringMatching(/send-email hook is not enabled/)]);
  });

  it("checks every ENABLED http hook, skips disabled ones and pg-functions hooks", () => {
    const r = liveHooks(
      liveConfig(EXPECTED_SEND_EMAIL_HOOK_URI, {
        hook_mfa_verification_attempt_enabled: true,
        hook_mfa_verification_attempt_uri: "pg-functions://postgres/public/mfa_hook",
      }),
    );
    expect(r.problems).toEqual([]);
    expect(r.hooks.map((h) => h.name).sort()).toEqual(["mfa_verification_attempt", "send_email"]);
  });

  it("never prints the token, the hook secret or the config body", async () => {
    const out = capture();
    await main(
      ["--live"],
      { SUPABASE_ACCESS_TOKEN: TOKEN },
      {
        fetchAuthConfig: async () => liveConfig(WWW),
        lookup: nxdomain,
        probe: answers(401),
      },
    );
    await main(
      ["--live"],
      { SUPABASE_ACCESS_TOKEN: TOKEN },
      {
        fetchAuthConfig: async () => {
          throw new Error("Management API answered 401 for the auth config");
        },
      },
    );
    expect(out()).not.toContain("sbp_");
    expect(out()).not.toContain("MUST_NOT_BE_PRINTED");
    expect(out()).not.toContain("whsec_");
    expect(out()).not.toContain("site_url");
  });

  it("a missing token or an unreadable config is exit 2, never a pass", async () => {
    capture();
    expect(await main(["--live"], {}, {})).toBe(2);
    expect(
      await main(
        ["--live"],
        { SUPABASE_ACCESS_TOKEN: TOKEN },
        {
          fetchAuthConfig: async () => {
            throw new Error("Management API answered 403 for the auth config");
          },
        },
      ),
    ).toBe(2);
  });

  it("with a token and no URI override, live is the DEFAULT path (no --live needed)", async () => {
    capture();
    let read = false;
    const code = await main(
      [],
      { SUPABASE_ACCESS_TOKEN: TOKEN },
      {
        fetchAuthConfig: async () => {
          read = true;
          return liveConfig(WWW);
        },
        lookup: nxdomain,
        probe: answers(401),
      },
    );
    expect(read).toBe(true);
    expect(code).toBe(1);
  });

  it("fetchAuthConfig is a read-only GET of the prod project's auth config, token only in the header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(liveConfig(WWW)), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = await fetchAuthConfig({ ref: PROD_SUPABASE_REF, token: TOKEN, fetchImpl });
    expect(cfg.hook_send_email_uri).toBe(WWW);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.supabase.com/v1/projects/vsxzrbxublqrcfnxfwcu/config/auth",
    );
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].url).not.toContain(TOKEN);

    const refused = (async () =>
      new Response('{"message":"secret-ish body"}', { status: 401 })) as unknown as typeof fetch;
    await expect(
      fetchAuthConfig({ ref: PROD_SUPABASE_REF, token: TOKEN, fetchImpl: refused }),
    ).rejects.toThrow(/^Management API answered 401 for the auth config$/);
  });

  it("the script never writes Auth config: no PUT/PATCH/POST to the Management API", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/method:\s*"(PUT|PATCH|DELETE)"/);
    // the only POST is the unsigned probe of the hook route itself
    expect(src.match(/method:\s*"POST"/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/\/v1\/projects\/\$\{encodeURIComponent\(ref\)\}\/config\/auth/);
    expect(PROD_SUPABASE_REF).toBe("vsxzrbxublqrcfnxfwcu");
  });
});
