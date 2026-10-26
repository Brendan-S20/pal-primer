// A booking link is previewed as the business, not as us (#524).
//
// When a business texted /signup/{slug}, the unfurl, the tab and the HTML a
// crawler fetched all said HoundStack: "Get a quote" for a title, our
// og:title, our og:image, and a body with no business in it, because the
// lookup ran only in the browser. A link unfurler does not run JavaScript, so
// what it saw is exactly what this spec fetches: the server's HTML, with no
// browser at all.
//
// Against the real local stack rather than the viewport stub, because the
// claim is about the SERVER's render, and the stub only answers the browser.
// The page is reached at the seeded org's portal address, set here and put
// back after.

import { expect, test } from "@playwright/test";

import { serviceDb, e2eOrgId, E2E_ORG_NAME } from "./service-db";

const SLUG = "e2e-booking-link-preview";

/** The <head>, and the body's text with scripts and styles taken out: what
 *  a person or an unfurler reads, not the bundle's own source. */
function split(html: string) {
  const head = html.slice(0, html.indexOf("</head>"));
  const body = html
    .slice(html.indexOf("<body"))
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    // React escapes text, so "isn't" arrives as "isn&#x27;t".
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  return { head, body };
}

/** No title or meta tag carries our name or our preview image. A URL is
 *  taken out first: the page and its image are served from the app's own
 *  host, which is an address, not a brand anybody reads in an unfurl. */
function expectNoBrandOfOurs(head: string) {
  const tags = head.match(/<title>[^<]*<\/title>|<meta[^>]*>/g) ?? [];
  for (const t of tags) {
    expect(t, t).not.toMatch(/og-image\.png/);
    expect(t.replace(/https?:\/\/[^"\s]+/g, ""), t).not.toMatch(/houndstack/i);
  }
}

function metaContent(head: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]*(?:property|name)="${key}"[^>]*>`, "i");
  const tag = head.match(re)?.[0];
  return tag?.match(/content="([^"]*)"/)?.[1] ?? null;
}

test("the server's HTML names the business and carries the form", async ({ request }) => {
  test.setTimeout(120_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const { data: before } = await db
    .from("organizations")
    .select("portal_slug")
    .eq("id", orgId)
    .single();
  const { error } = await db.from("organizations").update({ portal_slug: SLUG }).eq("id", orgId);
  if (error) throw new Error(`setting the portal address: ${error.message}`);

  try {
    const res = await request.get(`/signup/${SLUG}`);
    expect(res.status()).toBe(200);
    const { head, body } = split(await res.text());

    const title = head.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    expect(title).toContain(E2E_ORG_NAME);
    expect(metaContent(head, "og:title")).toContain(E2E_ORG_NAME);
    expect(metaContent(head, "twitter:title")).toContain(E2E_ORG_NAME);
    expect(metaContent(head, "og:site_name")).toBe(E2E_ORG_NAME);
    expect(metaContent(head, "description")).toContain(E2E_ORG_NAME);
    expect(metaContent(head, "og:url")).toMatch(new RegExp(`/signup/${SLUG}$`));
    expect(head).toMatch(new RegExp(`<link[^>]*rel="canonical"[^>]*/signup/${SLUG}"`));
    // The seeded org has no logo, so the neutral image, not og-image.png.
    expect(metaContent(head, "og:image")).toMatch(/\/booking-preview\.png$/);

    // Nothing a reader or an unfurler sees says HoundStack.
    expectNoBrandOfOurs(head);
    expect(body).not.toMatch(/houndstack/i);

    // The page itself is rendered on the server: the business and step 1.
    expect(body).toContain(E2E_ORG_NAME);
    expect(body).toContain("1. Your service");
    expect(body).not.toContain("Loading…");
  } finally {
    await db
      .from("organizations")
      .update({ portal_slug: before?.portal_slug ?? null })
      .eq("id", orgId);
  }
});

test("a slug that names no business is a 404, unbranded", async ({ request }) => {
  const res = await request.get("/signup/no-such-business-xyz");
  expect(res.status()).toBe(404);
  const { head, body } = split(await res.text());
  expect(body).toContain("This page isn't available");
  expect(body).not.toMatch(/houndstack/i);
  // The root's tags are overridden here too: a wrong link does not preview
  // as HoundStack's own pitch.
  expectNoBrandOfOurs(head);
});
