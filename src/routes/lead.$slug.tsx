import { createFileRoute, redirect } from "@tanstack/react-router";
import { retiredLeadFormHref } from "@/lib/new-customer-form";

// The hosted lead form's old address. It forwards to /signup/{slug}, the one
// public form a business has now (see lib/new-customer-form.ts for why there
// used to be two and why there is one).
//
// Every query parameter comes along as it arrived (zone, ref, utm_*, embed and
// anything a tenant's own website appends), because this address is printed on
// flyers, pasted into Google listings and set as the src of iframes on tenants'
// websites, none of which anybody here can edit.
//
// 302, not 301, on purpose. A 301 is cached by the browser with no expiry, so
// if the owner ever decides the form should live at this address instead, every
// visitor who had been here once would bounce between the two forever. A
// temporary redirect costs one extra round trip and keeps that decision open.
//
// No `ssr: false` (the old form had it): beforeLoad has to run on the server so
// the redirect is an HTTP response that an iframe, a crawler or a link preview
// follows, not a page that waits for JavaScript to send it somewhere else.
export const Route = createFileRoute("/lead/$slug")({
  beforeLoad: ({ params, location }) => {
    throw redirect({
      href: retiredLeadFormHref(params.slug, location.searchStr),
      statusCode: 302,
    });
  },
});
