// A webhook cannot be pointed inside the building.
//
// A webhook is a request this server makes to a URL a tenant typed, so
// without these checks it is a server-side request forgery primitive: the
// cloud metadata service at 169.254.169.254, a database on 127.0.0.1, anything
// on 10.x. These are the refusals, one per range, at both of the places they
// apply — when the endpoint is saved and before every send, because a name
// that was public when it was saved can be repointed afterwards.
//
// No DNS and no network here: every resolver is a fake, and so is fetch.

import { describe, expect, it, vi } from "vitest";
import {
  blockedAddressReason,
  checkResolvedAddresses,
  checkWebhookUrl,
  parseIPv6,
} from "@/lib/webhook-url-safety";
import {
  HostDidNotResolve,
  checkWebhookDestination,
  sendWebhook,
  type Resolver,
} from "@/lib/webhook-delivery.server";

const resolvesTo =
  (...addrs: string[]): Resolver =>
  async () =>
    addrs;

describe("the URL itself", () => {
  it("must be https", () => {
    for (const u of [
      "http://hooks.example.com/x",
      "ftp://hooks.example.com/",
      "file:///etc/passwd",
      "gopher://x.example.com",
    ]) {
      const r = checkWebhookUrl(u);
      expect(r.ok, u).toBe(false);
    }
    expect(checkWebhookUrl("http://hooks.example.com/x")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/https/),
    });
  });

  it("cannot carry a username or password", () => {
    expect(checkWebhookUrl("https://user:pass@hooks.example.com/")).toMatchObject({ ok: false });
  });

  it("accepts a public https address and drops the fragment", () => {
    const r = checkWebhookUrl("https://hooks.zapier.com/hooks/catch/123/abc/#frag");
    expect(r).toMatchObject({
      ok: true,
      href: "https://hooks.zapier.com/hooks/catch/123/abc/",
      host: "hooks.zapier.com",
    });
  });
});

describe("IP literals, one per blocked range", () => {
  const blocked: Array<[string, RegExp]> = [
    ["https://127.0.0.1/", /loopback/],
    ["https://127.255.255.254/", /loopback/],
    ["https://10.0.0.1/", /private/],
    ["https://10.255.255.255/", /private/],
    ["https://172.16.0.1/", /private/],
    ["https://172.31.255.255/", /private/],
    ["https://192.168.1.1/", /private/],
    ["https://169.254.169.254/latest/meta-data/", /link-local/],
    ["https://0.0.0.0/", /unspecified/],
    ["https://100.64.0.1/", /carrier-grade/],
    ["https://224.0.0.1/", /multicast/],
    ["https://255.255.255.255/", /reserved/],
    ["https://[::1]/", /loopback/],
    ["https://[::]/", /unspecified/],
    ["https://[fc00::1]/", /fc00::\/7/],
    ["https://[fd12:3456:789a::1]/", /fc00::\/7/],
    ["https://[fe80::1]/", /fe80::\/10/],
    ["https://[febf::1]/", /fe80::\/10/],
    ["https://[ff02::1]/", /multicast/],
  ];
  for (const [u, why] of blocked) {
    it(`refuses ${u}`, () => {
      const r = checkWebhookUrl(u);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(why);
    });
  }

  it("refuses loopback however the IPv4 is spelled", () => {
    // The URL parser canonicalises these to 127.0.0.1 before the check sees
    // them; this pins that the check is reading the canonical form.
    for (const u of [
      "https://2130706433/",
      "https://0x7f000001/",
      "https://0x7f.1/",
      "https://127.1/",
      "https://017700000001/",
    ]) {
      expect(checkWebhookUrl(u).ok, u).toBe(false);
    }
  });

  it("refuses IPv4 smuggled inside IPv6", () => {
    for (const u of [
      "https://[::ffff:127.0.0.1]/", // IPv4-mapped, canonicalised to ::ffff:7f00:1
      "https://[::ffff:169.254.169.254]/",
      "https://[::ffff:10.0.0.1]/",
      "https://[::127.0.0.1]/", // deprecated IPv4-compatible
      "https://[64:ff9b::a00:1]/", // NAT64 for 10.0.0.1
      "https://[2002:c0a8:101::1]/", // 6to4 for 192.168.1.1
    ]) {
      expect(checkWebhookUrl(u).ok, u).toBe(false);
    }
  });

  it("allows public literals just outside the private ranges", () => {
    for (const u of [
      "https://172.32.0.1/",
      "https://172.15.255.255/",
      "https://11.0.0.1/",
      "https://8.8.8.8/",
      "https://[2606:4700:4700::1111]/",
      "https://[::ffff:8.8.8.8]/",
    ]) {
      expect(checkWebhookUrl(u).ok, u).toBe(true);
    }
  });
});

describe("names that are never public", () => {
  for (const u of [
    "https://localhost/",
    "https://LOCALHOST:8443/x",
    "https://localhost./",
    "https://api.localhost/",
    "https://printer.local/",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://db.internal/",
    "https://nas.lan/",
    "https://router.home.arpa/",
    "https://intranet/",
  ]) {
    it(`refuses ${u}`, () => {
      expect(checkWebhookUrl(u).ok).toBe(false);
    });
  }
});

describe("where a name resolves, at save time", () => {
  const privateAnswers: Array<[string, string]> = [
    ["127/8", "127.0.0.1"],
    ["10/8", "10.1.2.3"],
    ["172.16/12", "172.20.0.5"],
    ["192.168/16", "192.168.0.10"],
    ["169.254/16", "169.254.169.254"],
    ["0.0.0.0", "0.0.0.0"],
    ["::1", "::1"],
    ["fc00::/7", "fd00:ec2::254"],
    ["fe80::/10", "fe80::1%eth0"],
    ["IPv4-mapped", "::ffff:10.0.0.1"],
  ];
  for (const [range, addr] of privateAnswers) {
    it(`refuses a public-looking name that resolves into ${range}`, async () => {
      const r = await checkWebhookDestination("https://hooks.example.com/in", resolvesTo(addr));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toContain(addr);
    });
  }

  it("refuses when ANY answer is private, not just the first", async () => {
    const r = await checkWebhookDestination(
      "https://hooks.example.com/in",
      resolvesTo("93.184.216.34", "10.0.0.7"),
    );
    expect(r.ok).toBe(false);
  });

  it("accepts a name whose every answer is public", async () => {
    const r = await checkWebhookDestination(
      "https://hooks.example.com/in",
      resolvesTo("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"),
    );
    expect(r).toMatchObject({ ok: true, host: "hooks.example.com" });
  });

  it("refuses a name that does not resolve", async () => {
    const r = await checkWebhookDestination("https://nope.example.com/", async (h) => {
      throw new HostDidNotResolve(h);
    });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/does not resolve/) });
  });

  it("fails CLOSED when the address cannot be checked at all", async () => {
    const r = await checkWebhookDestination("https://hooks.example.com/", async () => {
      throw new Error("not implemented in this runtime");
    });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Could not check/) });
  });

  it("does not call the resolver for a literal it has already judged", async () => {
    const resolve = vi.fn(resolvesTo("10.0.0.1"));
    expect(await checkWebhookDestination("https://8.8.8.8/", resolve)).toMatchObject({ ok: true });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("and again at send time, because DNS can change", () => {
  it("does not send when the name now resolves to a private address", async () => {
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const r = await sendWebhook(
      {
        url: "https://hooks.example.com/in",
        secret: "whsec_x",
        body: "{}",
        eventType: "visit.completed",
        deliveryId: "d1",
      },
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        resolve: resolvesTo("169.254.169.254"),
        now: () => new Date(),
      },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Refused: .*169\.254\.169\.254/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends when it still resolves publicly", async () => {
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const r = await sendWebhook(
      {
        url: "https://hooks.example.com/in",
        secret: "whsec_x",
        body: "{}",
        eventType: "visit.completed",
        deliveryId: "d1",
      },
      {
        fetch: fetch as unknown as typeof globalThis.fetch,
        resolve: resolvesTo("93.184.216.34"),
        now: () => new Date(),
      },
    );
    expect(r).toEqual({ ok: true, statusCode: 200, error: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("the address parser the checks rest on", () => {
  it("expands compressed IPv6 and reads embedded IPv4", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6(":::")).toBeNull();
    expect(parseIPv6("1::2::3")).toBeNull();
  });

  it("refuses an answer it cannot read rather than waving it through", () => {
    expect(blockedAddressReason("not-an-ip")).toMatch(/can read/);
    expect(checkResolvedAddresses("h.example.com", [])).toMatchObject({ ok: false });
  });
});
