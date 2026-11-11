/**
 * A person, rendered as a photo or their initials.
 *
 * The `avatars` bucket is private (see migration 20260805120000), so a stored
 * path is not something an <img> can load — it has to be signed first. That is
 * one round trip per avatar, which is why this component exists rather than
 * the signing being inlined at each of the four call sites: the sidebar, the
 * header menu, the profile page and Users & roles.
 *
 * The fallback is initials on a colour derived from the person's id, not a
 * grey circle. On the dispatch board the colour IS how you tell two lanes
 * apart at a glance, and a row of identical grey discs would take that away
 * from everyone who has not uploaded a photo — which, on day one, is everyone.
 */
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useSignedUrl } from "@/hooks/useSignedUrl";
import { cn } from "@/lib/utils";

/** "Dana Whitfield" -> "DW"; "Cher" -> "C"; "" -> "?" */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Fixed palette rather than a random hue: these are picked to stay legible
// against white text in both themes, which a generated HSL will not reliably do.
// The 700 step, not 600: at 600 five of the eight were under 4.5:1 with white
// initials (emerald 3.65, amber 3.19, teal, orange and sky under 4.2), and axe
// found the emerald one on every signed-in page, in the header's account menu
// (gaps-r2-11 part 2). Every 700 here clears 4.5:1 with white.
const TONES = [
  "bg-sky-700",
  "bg-emerald-700",
  "bg-violet-700",
  "bg-amber-700",
  "bg-rose-700",
  "bg-teal-700",
  "bg-indigo-700",
  "bg-orange-700",
];

/** Stable per person — the same id always lands on the same tone. */
export function toneOf(seed: string | null | undefined): string {
  if (!seed) return "bg-muted-foreground";
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length];
}

export function UserAvatar({
  name,
  avatarPath,
  seed,
  className,
  textClassName,
}: {
  name: string | null | undefined;
  /** Storage path, not a URL. Null while loading or when none is set. */
  avatarPath?: string | null;
  /** Usually the staff id. Falls back to the name so a list without ids still
      gets stable, distinguishable colours. */
  seed?: string | null;
  className?: string;
  textClassName?: string;
}) {
  const { url } = useSignedUrl("avatars", avatarPath ?? null);
  return (
    <Avatar className={cn("h-8 w-8", className)}>
      {url && <AvatarImage src={url} alt="" />}
      <AvatarFallback
        className={cn("font-medium text-white", toneOf(seed ?? name), textClassName)}
      >
        {initialsOf(name)}
      </AvatarFallback>
    </Avatar>
  );
}
