// Where a webhook is allowed to point.
//
// A webhook is a request this server makes to a URL a tenant typed. Left
// alone that is a server-side request forgery primitive: point it at
// 169.254.169.254 and the cloud metadata service answers; point it at
// 127.0.0.1:5432 and the response codes map the host's ports; point it at
// 10.0.0.1 and it reaches whatever shares the network. The owner is the one
// typing, but an owner's account is exactly what a phished password hands
// somebody else.
//
// So the rule is: HTTPS, a real public hostname or a public IP literal, and
// every address that hostname resolves to must be public. Checked when the
// endpoint is saved AND again before every send, because DNS can change
// between the two — a name that resolved to a public address at save time can
// be repointed at 127.0.0.1 the next minute.
//
// This file is pure: parsing and classifying, no DNS and no network. The DNS
// half is in webhook-delivery.server.ts, which feeds its answers to
// checkResolvedAddresses below. Keeping the two apart is what lets the tests
// exercise every range without a resolver and without a network.
//
// ── WHAT THE URL PARSER ALREADY DOES FOR US ───────────────────────────────
//
// The WHATWG URL parser canonicalises IPv4 in every legacy spelling before we
// see it: `https://2130706433/`, `https://0x7f.1/` and `https://127.1/` all
// come out with hostname "127.0.0.1". IPv6 comes out compressed and bracketed,
// and an IPv4-mapped literal comes out in hex (`[::ffff:7f00:1]`), which is
// why the IPv6 parser below reads embedded IPv4 out of the last two groups
// rather than looking for a dotted quad. Zone ids (`%eth0`) are rejected by
// the parser outright.

export type UrlCheck =
  { ok: true; url: URL; href: string; host: string } | { ok: false; reason: string };

export type AddressCheck = { ok: true } | { ok: false; reason: string };

/** Hostnames that name this machine or a cloud's internal services. */
const BLOCKED_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes.default",
]);

/** Suffixes that are never public DNS. A name under one of these that did
 *  resolve would be resolving through somebody's private resolver. */
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
  ".lan",
  ".home",
  ".corp",
];

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** The hostname as the checks want it: lower case, IPv6 brackets off, a
 *  trailing root dot off (`localhost.` is localhost). */
export function normalizedHost(url: URL): string {
  let h = url.hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * The save-time and send-time check that needs no DNS: scheme, credentials,
 * shape of the host, IP literals, and names that are never public.
 */
export function checkWebhookUrl(raw: string): UrlCheck {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fail("Enter the URL to send events to.");
  if (trimmed.length > 2048) return fail("That URL is longer than 2048 characters.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fail("That is not a valid URL.");
  }

  if (url.protocol !== "https:") {
    return fail(
      "The URL must start with https://. Events are signed, but they are not sent in the clear.",
    );
  }
  if (url.username || url.password) {
    return fail(
      "The URL cannot contain a username or password. Use the signing secret to verify requests.",
    );
  }

  const host = normalizedHost(url);
  if (!host) return fail("The URL has no host.");

  if (isIPv4Literal(host) || host.includes(":")) {
    const why = blockedAddressReason(host);
    if (why) return fail(`That address is ${why}, which webhooks cannot be sent to.`);
  } else {
    if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
      return fail(`${host} is a local or internal name, which webhooks cannot be sent to.`);
    }
    if (!host.includes(".")) {
      return fail(
        `${host} is not a full domain name. Use the public address, like hooks.example.com.`,
      );
    }
  }

  url.hash = "";
  return { ok: true, url, href: url.toString(), host };
}

/**
 * Every address a hostname resolved to must be public. ALL of them, not the
 * first: a name with one public and one private A record is a coin toss on
 * which one the HTTP client connects to.
 */
export function checkResolvedAddresses(host: string, addresses: readonly string[]): AddressCheck {
  if (addresses.length === 0) return fail(`${host} does not resolve to any address.`);
  for (const a of addresses) {
    const why = blockedAddressReason(a);
    if (why) return fail(`${host} resolves to ${a}, ${why}, which webhooks cannot be sent to.`);
  }
  return { ok: true };
}

// ── Addresses ──────────────────────────────────────────────────────────────

export function isIPv4Literal(s: string): boolean {
  return parseIPv4(s) !== null;
}

/** Strict dotted quad. Anything the URL parser did not canonicalise is not
 *  an address this file will vouch for. */
export function parseIPv4(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

/** Eight 16-bit groups, or null. Accepts `::` compression and a trailing
 *  dotted quad; drops a zone id, which a resolver may append. */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":")) return null;

  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1) + "0"; // placeholder group, replaced below
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !rest) return null;

  let groups: number[];
  const want = tail.length ? 7 : 8; // the dotted quad took one placeholder slot
  if (halves.length === 2) {
    const fill = want - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array(fill).fill(0), ...rest];
  } else {
    groups = head;
    if (groups.length !== want) return null;
  }
  if (tail.length) groups = [...groups.slice(0, 6), ...tail];
  return groups.length === 8 ? groups : null;
}

/** Why an IPv4 address is not public, or null when it is. */
export function blockedIPv4Reason([a, b, c]: [number, number, number, number]): string | null {
  if (a === 0) return "an unspecified address (0.0.0.0/8)";
  if (a === 10) return "a private network address (10.0.0.0/8)";
  if (a === 100 && b >= 64 && b <= 127) return "a carrier-grade NAT address (100.64.0.0/10)";
  if (a === 127) return "a loopback address (127.0.0.0/8)";
  if (a === 169 && b === 254) {
    return "a link-local address (169.254.0.0/16, where cloud metadata services live)";
  }
  if (a === 172 && b >= 16 && b <= 31) return "a private network address (172.16.0.0/12)";
  if (a === 192 && b === 0 && c === 0) return "a protocol-assignment address (192.0.0.0/24)";
  if (a === 192 && b === 0 && c === 2) return "a documentation address (192.0.2.0/24)";
  if (a === 192 && b === 168) return "a private network address (192.168.0.0/16)";
  if (a === 198 && (b === 18 || b === 19)) return "a benchmarking address (198.18.0.0/15)";
  if (a === 198 && b === 51 && c === 100) return "a documentation address (198.51.100.0/24)";
  if (a === 203 && b === 0 && c === 113) return "a documentation address (203.0.113.0/24)";
  if (a >= 224 && a <= 239) return "a multicast address (224.0.0.0/4)";
  if (a >= 240) return "a reserved address (240.0.0.0/4)";
  return null;
}

function v4FromGroups(hi: number, lo: number): [number, number, number, number] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/** Why an IPv6 address is not public, or null when it is. Addresses that
 *  carry an IPv4 address inside them are judged by that IPv4 address. */
export function blockedIPv6Reason(g: number[]): string | null {
  const zeroThrough = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (g.every((x) => x === 0)) return "an unspecified address (::)";
  if (zeroThrough(7) && g[7] === 1) return "a loopback address (::1)";
  if ((g[0] & 0xfe00) === 0xfc00) return "a private network address (fc00::/7)";
  if ((g[0] & 0xffc0) === 0xfe80) return "a link-local address (fe80::/10)";
  if ((g[0] & 0xffc0) === 0xfec0) return "a site-local address (fec0::/10)";
  if ((g[0] & 0xff00) === 0xff00) return "a multicast address (ff00::/8)";
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "a documentation address (2001:db8::/32)";
  if (g[0] === 0x2001 && g[1] === 0) return "a Teredo tunnel address (2001::/32)";
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) {
    return "a discard-only address (100::/64)";
  }
  // IPv4-mapped ::ffff:a.b.c.d, and the deprecated IPv4-compatible ::a.b.c.d.
  if (zeroThrough(5) && (g[5] === 0xffff || g[5] === 0)) {
    const inner = blockedIPv4Reason(v4FromGroups(g[6], g[7]));
    return inner ? `an IPv4 address in IPv6 form that is ${inner}` : null;
  }
  // NAT64, 64:ff9b::a.b.c.d.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const inner = blockedIPv4Reason(v4FromGroups(g[6], g[7]));
    return inner ? `a NAT64 address for ${inner}` : null;
  }
  // 6to4, 2002:AABB:CCDD::.
  if (g[0] === 0x2002) {
    const inner = blockedIPv4Reason(v4FromGroups(g[1], g[2]));
    return inner ? `a 6to4 address for ${inner}` : null;
  }
  return null;
}

/** Why an address (IPv4 or IPv6, as text) is not public, or null when it is.
 *  Something that does not parse as either is refused: a resolver answer this
 *  file cannot read is not one it can vouch for. */
export function blockedAddressReason(address: string): string | null {
  const v4 = parseIPv4(address);
  if (v4) return blockedIPv4Reason(v4);
  const v6 = parseIPv6(address);
  if (v6) return blockedIPv6Reason(v6);
  return "not an IP address this check can read";
}
