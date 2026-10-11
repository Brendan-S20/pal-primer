// Single source of truth for the app-name string.
export const APP_NAME = "HoundStack";
// The /auth tagline. Decided by the owner on 2026-10-09 (A-P0-3): the whole
// business system for recurring pet service businesses, with no pet-waste-first
// qualifier. Routing is a feature, not the product, so this never says
// "routing". The share tags in __root.tsx say the same thing.
export const APP_DESCRIPTION = "Run your whole recurring pet service business from one app";
// APP_URL used to live here. It was imported by nothing, and it named
// app.houndstack.com — the host that 307-redirects rather than the one that
// answers. Use appOrigin() from @/lib/app-origin, which reads the environment
// and has one default to change if the CDN redirect is ever removed.
