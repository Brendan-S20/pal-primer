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
const TONES = [
  "bg-sky-600",
  "bg-emerald-600",
  "bg-violet-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-teal-600",
  "bg-indigo-600",
  "bg-orange-600",
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
