// #807: the leaked-password check, asked on Get started's first step.
//
// lib/password-breach.ts asks Have I Been Pwned's range API the way the auth
// server does, and checkNewPassword (auth-entry.functions.ts) turns a hit
// into the auth server's own sentence. These pin the parts that must not
// drift: only a five-character prefix leaves the server, padding rows are not
// hits, anything but a clean answer is "couldn't tell" (null), and the
// wording is the same one registerAccount gives at the end.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { HIBP_RANGE_URL, isPasswordBreached } from "@/lib/password-breach";
import {
  isPasswordRejection,
  LEAKED_PASSWORD_REASON,
  passwordRejectionMessage,
} from "@/lib/password-policy";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").toUpperCase();

function rangeFetch(body: string, status = 200) {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch & {
    mock: { calls: [string, RequestInit][] };
  };
}

describe("isPasswordBreached", () => {
  const pw = "password1";
  const hash = sha1(pw);

  it("sends only the five-character hash prefix, padded", async () => {
    const f = rangeFetch("");
    await isPasswordBreached(pw, { fetch: f });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`${HIBP_RANGE_URL}${hash.slice(0, 5)}`);
    expect(url).not.toContain(hash.slice(5));
    expect(url).not.toContain(pw);
    expect((init.headers as Record<string, string>)["Add-Padding"]).toBe("true");
  });

  it("a suffix in the range with a count is a hit", async () => {
    const f = rangeFetch(`0000000000000000000000000000000000A:3\r\n${hash.slice(5)}:24230577\r\n`);
    expect(await isPasswordBreached(pw, { fetch: f })).toBe(true);
  });

  it("matches the suffix whatever its case", async () => {
    const f = rangeFetch(`${hash.slice(5).toLowerCase()}:2`);
    expect(await isPasswordBreached(pw, { fetch: f })).toBe(true);
  });

  it("a padding row (count 0) is not a hit", async () => {
    const f = rangeFetch(`${hash.slice(5)}:0\r\n`);
    expect(await isPasswordBreached(pw, { fetch: f })).toBe(false);
  });

  it("a suffix that is not in the range is not a hit", async () => {
    const f = rangeFetch("0000000000000000000000000000000000A:3\r\n");
    expect(await isPasswordBreached(pw, { fetch: f })).toBe(false);
  });

  it("an error status is 'couldn't tell', not 'safe'", async () => {
    expect(await isPasswordBreached(pw, { fetch: rangeFetch("", 503) })).toBeNull();
  });

  it("a network failure is 'couldn't tell', not a throw", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await isPasswordBreached(pw, { fetch: f })).toBeNull();
  });
});

describe("the wording is the auth server's, said once", () => {
  it("the first-step refusal is the same sentence registerAccount gives at the end", () => {
    const early = passwordRejectionMessage(LEAKED_PASSWORD_REASON);
    expect(early).toBe(
      "That password can't be used: Password is known to be weak and easy to guess, please choose a different one.",
    );
    // And every form recognises it as being about the password.
    expect(isPasswordRejection(new Error(early))).toBe(true);
    expect(isPasswordRejection({ message: LEAKED_PASSWORD_REASON })).toBe(true);
  });

  it("checkNewPassword validates with the shared rules, then asks the breach list", () => {
    const src = readFileSync("src/lib/auth-entry.functions.ts", "utf8");
    const fn = src.slice(src.indexOf("export const checkNewPassword"));
    const body = fn.slice(0, fn.indexOf("export const", 10));
    expect(body).toMatch(/password:\s*passwordSchema/);
    expect(body).toContain("isPasswordBreached");
    expect(body).toContain("LEAKED_PASSWORD_REASON");
    expect(body.indexOf("passwordSchema")).toBeLessThan(body.indexOf("isPasswordBreached"));
    // It reads and writes nothing: no admin client, no table.
    expect(body).not.toMatch(/supabaseAdmin|\.from\(|\.rpc\(/);
  });
});
