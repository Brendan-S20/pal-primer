// A webhook does not follow a redirect.
//
// The address check runs on the URL the owner saved. A receiver at a public
// address that answers `302 Location: http://169.254.169.254/latest/meta-data`
// would walk a following client straight past it, which is the oldest way
// around an SSRF check. So the request is made with `redirect: "manual"`, and
// a 3xx is recorded as a failed attempt that says what happened.
//
// The fake fetch below behaves the way a real one does: with any redirect
// mode other than "manual" it follows the Location and returns the metadata
// service's 200. That is what makes the first test fail if the option is ever
// changed, rather than merely checking a string.

import { describe, expect, it, vi } from "vitest";
import { SEND_TIMEOUT_MS, sendWebhook, type SendDeps } from "@/lib/webhook-delivery.server";

const ARGS = {
  url: "https://hooks.example.com/in",
  secret: "whsec_test",
  body: '{"id":"e1"}',
  eventType: "visit.completed",
  deliveryId: "d1",
};

function deps(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  extra: Partial<SendDeps> = {},
): SendDeps {
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    resolve: async () => ["93.184.216.34"],
    now: () => new Date("2026-09-29T12:00:00Z"),
    ...extra,
  };
}

/** A receiver that redirects to the metadata service, served by a fetch that
 *  follows redirects unless told not to. */
function redirectingFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const redirect = new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/iam" },
    });
    if (init.redirect === "manual") return redirect;
    calls.push({ url: "http://169.254.169.254/latest/meta-data/iam", init });
    return new Response("role-credentials", { status: 200 });
  });
  return { impl, calls };
}

describe("a receiver that answers with a redirect", () => {
  it("is not followed: one request, to the saved URL, and the attempt fails", async () => {
    const { impl, calls } = redirectingFetch();
    const r = await sendWebhook(ARGS, deps(impl));
    expect(calls.map((c) => c.url)).toEqual(["https://hooks.example.com/in"]);
    expect(calls[0].init.redirect).toBe("manual");
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(302);
    expect(r.error).toMatch(/Redirected to http:\/\/169\.254\.169\.254.*not followed/);
  });

  for (const status of [301, 303, 307, 308]) {
    it(`treats ${status} the same way`, async () => {
      const r = await sendWebhook(
        ARGS,
        deps(
          async () =>
            new Response(null, { status, headers: { location: "https://elsewhere.example.com/" } }),
        ),
      );
      expect(r).toMatchObject({ ok: false, statusCode: status });
    });
  }

  it("treats a browser-style opaque redirect as a redirect too", async () => {
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      headers: new Headers(),
      body: null,
    } as unknown as Response;
    const r = await sendWebhook(
      ARGS,
      deps(async () => opaque),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Redirected/);
  });
});

describe("the rest of the request", () => {
  it("POSTs the body as JSON with the signature, event and delivery headers", async () => {
    const seen: RequestInit[] = [];
    await sendWebhook(
      ARGS,
      deps(async (_u, init) => (seen.push(init), new Response(null, { status: 204 }))),
    );
    const h = seen[0].headers as Record<string, string>;
    expect(seen[0].method).toBe("POST");
    expect(seen[0].body).toBe(ARGS.body);
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["HoundStack-Signature"]).toMatch(/^t=1790683200,v1=[0-9a-f]{64}$/);
    expect(h["HoundStack-Event"]).toBe("visit.completed");
    expect(h["HoundStack-Delivery"]).toBe("d1");
  });

  it("gives up after the timeout and says so", async () => {
    expect(SEND_TIMEOUT_MS).toBe(10_000);
    const hang = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const r = await sendWebhook(ARGS, deps(hang, { timeoutMs: 30 }));
    expect(r).toMatchObject({ ok: false, statusCode: null });
    expect(r.error).toMatch(/No answer within/);
  });

  it("records a non-2xx answer with a short piece of the body", async () => {
    const r = await sendWebhook(
      ARGS,
      deps(async () => new Response("Zap is turned off\n" + "x".repeat(5000), { status: 410 })),
    );
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(410);
    expect(r.error).toMatch(/^HTTP 410: Zap is turned off/);
    expect(r.error!.length).toBeLessThan(260);
  });
});
