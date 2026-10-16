import { ADDON_LAUNCHED } from "@/lib/addon-launch";

/**
 * Whether the AI receptionist (texts and calls) is live.
 *
 * Owner decision, 2026-10-03: the receptionist launches later, as "coming
 * soon". It is the one AI feature triggered by people outside the business,
 * so until it is switched on here nothing may reach the model: the SMS and
 * voice webhooks skip it, and it cannot be switched on in Settings. The
 * add-on itself is `coming_soon` in `platform_addons`, which the billing page
 * already shows and `subscribePlatformAddon` already refuses.
 *
 * Turning it on is this line plus that row's status.
 */
export const RECEPTIONIST_LAUNCHED = ADDON_LAUNCHED["ai-receptionist"];
