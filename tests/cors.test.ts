import { describe, expect, it } from "vitest";
import { CORS_PATH_PREFIX, allowedOrigins, corsDecision } from "@/lib/cors.server";

// BUILD-9. CORS is the one place where a permissive mistake does not look like
// a bug — everything keeps working, and the only difference is that other
// people's websites can now call our server functions too. So the cases pinned
// here are the ones where a wrong answer is invisible.

const RPC = `${CORS_PATH_PREFIX}getMyDay`;
const IOS = "capacitor://localhost";
const ANDROID = "https://localhost";

describe("who is allowed", () => {
  it("answers the two origins Capacitor actually produces", () => {
    for (const origin of [IOS, ANDROID]) {
      const d = corsDecision({ method: "POST", path: RPC, origin });
      expect(d.kind, origin).toBe("actual");
      expect(d.kind === "actual" && d.headers["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("never answers with a wildcard", () => {
    // `*` would let any page on the internet call our server functions.
    const d = corsDecision({ method: "OPTIONS", path: RPC, origin: IOS });
    expect(JSON.stringify(d)).not.toContain("*");
  });

  it("ignores an origin it does not know, rather than reflecting it", () => {
    // Reflecting whatever arrives is the wildcard hole wearing a disguise, and
    // it reads as a working allowlist right up until someone tries it.
    for (const origin of [
      "https://evil.test",
      "null",
      "http://localhost",
      "capacitor://evil",
    ]) {
      expect(corsDecision({ method: "POST", path: RPC, origin }).kind, origin).toBe("ignore");
    }
  });

  it("does not fall for an origin that merely contains ours", () => {
    // The classic: a prefix or substring check lets this straight through.
    for (const origin of [
      "https://localhost.evil.test",
      "https://evil.test/https://localhost",
      "capacitor://localhost.evil.test",
    ]) {
      expect(corsDecision({ method: "POST", path: RPC, origin }).kind, origin).toBe("ignore");
    }
  });
});

describe("scope", () => {
  it("leaves same-origin requests completely alone", () => {
    // The hosted web app sends no Origin on its own RPC calls. It must come out
    // of here untouched — this change has to be invisible to the web product.
    expect(corsDecision({ method: "POST", path: RPC, origin: null }).kind).toBe("ignore");
  });

  it("covers only the RPC path", () => {
    // Pages, assets and the public webhooks have no reason to be readable by
    // another origin's JavaScript.
    for (const path of ["/my-day", "/api/public/hooks/stripe", "/assets/index.js", "/"]) {
      expect(corsDecision({ method: "POST", path, origin: IOS }).kind, path).toBe("ignore");
    }
  });
});

describe("the preflight answer", () => {
  const pre = corsDecision({ method: "OPTIONS", path: RPC, origin: IOS });
  const headers = pre.kind === "preflight" ? pre.headers : {};

  it("is recognised as a preflight so it never reaches auth", () => {
    // OPTIONS carries no Authorization by design. Letting it run the normal
    // path would reject the very request that exists to ask permission.
    expect(pre.kind).toBe("preflight");
  });

  it("allows every header the client actually sends", () => {
    // Any one of these forces the preflight; omitting one fails the whole call.
    // authorization = the bearer token, x-tsr-serverFn + the framed content-type
    // are set by TanStack's RPC fetcher.
    const allowed = headers["access-control-allow-headers"] ?? "";
    for (const h of ["authorization", "content-type", "x-tsr-serverfn"]) {
      expect(allowed, h).toContain(h);
    }
  });

  it("does NOT allow credentials", () => {
    // Deliberate. Auth is a bearer token from the app's own storage, which a
    // foreign page cannot read. Turning credentials on would let cookies ride
    // along cross-origin — and this deployment has no CSRF middleware active,
    // which is the combination that turns a CORS entry into session riding.
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("varies on Origin", () => {
    // Without it a shared cache can hand a response carrying one origin's
    // header to a request from another, which reads as a random failure.
    expect(headers["vary"]).toBe("Origin");
  });
});

describe("configured extra origins", () => {
  it("accepts a staging origin from the environment", () => {
    const env = "https://staging.houndstack.com";
    expect(corsDecision({ method: "POST", path: RPC, origin: env, env }).kind).toBe("actual");
  });

  it("does not allowlist the empty string from a trailing comma", () => {
    // "a,b," splits to three entries, and an empty allowed origin would match
    // a request that sent no Origin at all if the null check ever moved.
    expect(allowedOrigins("https://a.test,")).not.toContain("");
    expect(allowedOrigins(",,")).toEqual(allowedOrigins(undefined));
  });

  it("trims spaces so a readable list still works", () => {
    expect(allowedOrigins("https://a.test, https://b.test")).toContain("https://b.test");
  });

  it("keeps the native origins even when the env var is set", () => {
    // A staging entry must not silently replace the two that make the shipped
    // app work.
    const list = allowedOrigins("https://staging.houndstack.com");
    expect(list).toContain(IOS);
    expect(list).toContain(ANDROID);
  });
});
