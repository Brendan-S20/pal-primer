import { ComingSoonBadge } from "@/components/ComingSoonBadge";
import { useTextingState } from "@/hooks/useTextingState";
import { textingBadgeLabel, textingNotLiveSentence } from "@/lib/managed-texting";

/**
 * site-r2-05: what a texting control wears while it cannot send. Managed
 * texting is on sale, so the badge says where this business stands (Under
 * review, Setup needed, Add-on, Needs attention) instead of "Coming soon".
 * Same pill as ComingSoonBadge: shrink-0, never squeezed onto two lines.
 */
export function TextingStateBadge({ className = "" }: { className?: string }) {
  const label = textingBadgeLabel(useTextingState());
  if (!label) return null;
  return <ComingSoonBadge className={className}>{label}</ComingSoonBadge>;
}

/**
 * The sentence for a texting control that cannot send yet (it names the page
 * that fixes it, when there is one), then the screen's own tail ("Until then,
 * these messages go by email.").
 */
export function TextingNotLiveText({ tail }: { tail?: string }) {
  const sentence = textingNotLiveSentence(useTextingState());
  return <>{tail ? `${sentence} ${tail}` : sentence}</>;
}
