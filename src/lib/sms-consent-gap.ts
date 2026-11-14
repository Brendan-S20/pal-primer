import { canAccess, type AppRole } from "@/hooks/useMyRole";
import {
  textingNotLiveSentence,
  textingSetupLink,
  type ManagedTextingState,
} from "@/lib/managed-texting";

/**
 * #930: what the notice says after "...no texting consent on file,", by the
 * business's texting state and by whether the person reading can open the
 * page that changes it.
 *
 * Managed texting is on sale, so no state says texting is coming. A business
 * that has submitted is Under review in the words every other texting screen
 * uses (lib/managed-texting), with nothing to set up. A link is offered only
 * where `textingSetupLink` names a page AND this role may open it: a
 * dispatcher can read /clients but not Settings or Plan & billing, so they
 * get the same fact with no link that would bounce them. While the state is
 * loading or unreadable, nothing about setup is said at all.
 */
export function consentGapCopy(i: {
  texting: boolean;
  state: ManagedTextingState | undefined;
  role: AppRole | null;
}): { text: string; link: { to: string; label: string } | null } {
  if (i.texting) return { text: "so reminders and notifications will not reach them.", link: null };
  const to = textingSetupLink(i.state);
  const canOpen = to !== null && canAccess(i.role, to);
  switch (i.state) {
    case "under_review":
      return {
        text: `so they won't get texts yet. ${textingNotLiveSentence(i.state)}`,
        link: null,
      };
    case "needs_attention":
      return {
        text: "so they won't get texts yet. Your texting setup needs attention.",
        link: canOpen && to ? { to, label: "Open Texting settings" } : null,
      };
    case "not_added":
    case "needs_details":
      return canOpen && to
        ? {
            text: "so they won't get texts once you set up texting.",
            link: { to, label: "Set up texting" },
          }
        : { text: "so they won't get texts once texting is set up for your business.", link: null };
    default:
      return { text: "so they won't get texts.", link: null };
  }
}
