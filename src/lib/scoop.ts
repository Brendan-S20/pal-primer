// Single source of truth for the app-name string.
export const APP_NAME = "HoundStack";
// The positioning the App Store and Play listings carry (2026-10-07): a
// business system for route-based pet services, pet waste removal first.
// Routing is a feature, not the product, so this never says "routing".
export const APP_DESCRIPTION =
  "The business system for pet service companies that work a route, starting with pet waste removal.";
// APP_URL used to live here. It was imported by nothing, and it named
// app.houndstack.com — the host that 307-redirects rather than the one that
// answers. Use appOrigin() from @/lib/app-origin, which reads the environment
// and has one default to change if the CDN redirect is ever removed.
