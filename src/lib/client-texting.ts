/**
 * Whether a business can text its own clients, as the screens see it.
 *
 * Texting a business's clients goes only through that business's own Twilio
 * subaccount (`endCustomerSmsSender` in lib/twilio-credentials.server), which
 * exists once the business's Managed texting registration is approved and
 * activated (site-r2-05, lib/managed-texting). Every texting control in the app (Messages, the client page,
 * Settings, the automation toggles) reads ONE answer, per business, from
 * `getClientTextingAvailability`, which asks the same row by the same rule as
 * the sender. When a business's subaccount is provisioned its controls light
 * up and nobody else's do, with no copy change.
 *
 * This is the default while that answer is loading or could not be read: not
 * available. Offering a Send button that can only fail is the thing this
 * replaced, and a notice that flips to a working button a moment later costs
 * nothing.
 */
export const CLIENT_TEXTING_DEFAULT = false;

/** What the composer adds after the state sentence (TextingNotLiveText):
 *  "Texting your clients is under review, usually ready shortly." then this.
 *  site-r2-05 replaced the "coming soon" line that stood here: Managed
 *  texting is on sale, so a control says where this business stands instead.
 *  Office copy, so English; My Day hides its one texting button instead. */
export const TEXTING_NOT_LIVE_TAIL = "Until then, these messages go by email.";
