/** Where toasts sit. They are top-centre, and at the default offset they lay
 *  over the app header and swallowed clicks on its search button (#1065), so
 *  they start below the header (h-14, plus a gap) and any banner above it. */
const BELOW_HEADER = "var(--hs-banner-h, 0px) + 4rem";

/** Clear of a side inset in the native app (see the note on <Toaster> in
 *  routes/__root.tsx). */
const SIDE_INSET = "calc(max(env(safe-area-inset-left), env(safe-area-inset-right)) + 16px)";

export function toastOffset(native: boolean) {
  return native
    ? {
        top: `calc(env(safe-area-inset-top) + ${BELOW_HEADER})`,
        left: SIDE_INSET,
        right: SIDE_INSET,
      }
    : { top: `calc(${BELOW_HEADER})` };
}
