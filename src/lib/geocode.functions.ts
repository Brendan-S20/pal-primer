// The one way a browser may geocode.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// geocode.server.ts was written carefully: it enforces Nominatim's 1 req/sec
// limit, sends the descriptive User-Agent the usage policy requires, and
// returns a PRECISION, because Nominatim answers a house it does not know by
// returning the street centroid in a reply shaped exactly like a good one.
// That last part was measured against six ordinary US addresses and the
// imprecise answer was the COMMON case.
//
// Three UI files then called `https://nominatim.openstreetmap.org/search`
// directly from the browser, took `rows[0]`, and used it as the address:
// clients.new.tsx, settings.users.tsx and routes/StaffRoutingDialog.tsx.
// Each one therefore
//
//   * could not send the User-Agent the policy asks for, because fetch()
//     forbids setting it, so the request went out anonymously;
//   * shared no throttle with anything, because every browser is its own
//     process and there is nothing to coordinate through;
//   * came from the TENANT'S OWN IP, which is where a rate-limit block would
//     land; and
//   * discarded the precision, reintroducing the street-centroid bug the
//     server module exists to prevent, in the three screens that place a pin.
//
// The failure mode is the reason this is worth a server round trip rather than
// a header, and it differs by call site, so it is worth stating exactly:
// clients.new.tsx checks `r.ok` and does separate its "error" state from
// "notfound". settings.users.tsx and StaffRoutingDialog.tsx do NOT: neither
// checks the status, and both are wrapped in `catch { return null }`, so a 403,
// a 500 and a street name that genuinely does not exist all return the same
// null. In those two a policy block is indistinguishable from a typo, which is
// the CARTO failure again -- degradation that surfaces as ordinary emptiness.
//
// Auth-gated because all three callers are authenticated screens, and an
// unauthenticated geocoding proxy is an open relay for someone else's quota.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const lookupAddressPoint = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ query: z.string().min(3).max(300) }).parse(d))
  .handler(async ({ data }) => {
    const { geocodeAddressSourced } = await import("@/lib/geocode.server");
    // The callers pass one already-joined string, which is what they were
    // sending to Nominatim as `q`. geocodeAddress joins its parts the same way,
    // so handing it as `street` reproduces the identical query.
    const { point: geo, source } = await geocodeAddressSourced({ street: data.query });
    // `source` travels back with the pin when it is saved, so the property
    // records who produced it (properties.geocode_source).
    return { geo, source };
  });
