/**
 * Whether a business can text its own clients, as the screens see it.
 *
 * Texting a business's clients goes only through that business's own Twilio
 * subaccount (`endCustomerSmsSender` in lib/twilio-credentials.server), and
 * per-business numbers are waiting on carrier registration, so today no
 * business can. Every texting control in the app (Messages, the client page,
 * Settings, the automation toggles) reads ONE answer, per business, from
 * `getClientTextingAvailability`, which asks the same row by the same rule as
 * the sender. When a business's subaccount is provisioned its controls light
 * up and nobody else's do, with no copy change.
 *
 * This is the default while that answer is loading or could not be read: not
 * available. Offering a Send button that can only fail is the thing this
 * replaced, and a "Coming soon" that flips to a working button a moment later
 * costs nothing.
 */
export const CLIENT_TEXTING_DEFAULT = false;

/** The one line every texting control shows while texting is unavailable.
 *  Office copy, so English; My Day hides its one texting button instead. */
export const TEXTING_COMING_SOON_LINE =
  "Texting your clients is coming soon. Until then, these messages go by email.";
