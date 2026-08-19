// The badge that says WHO, in the colour the map already uses.
//
// The calendar used to mark a visit's technician with a 8px dot. A dot answers
// "is this the same person as that one" and nothing else — on a week column
// holding twenty chips it is twenty specks of colour, and the name of the tech
// is only reachable through a hover card, which a phone does not have.
//
// Initials in a filled circle answer both at once, at the same size a dot
// occupied, and they degrade honestly: a tech with no colour (assigned to
// somebody outside the routed staff list) still gets their initials in an
// outlined circle, and a visit with nobody on it gets an empty outline rather
// than a grey fill. Grey is a colour, and on a board where colour means "whose
// route" a grey badge reads as one more technician.
//
// ── WHERE THE COLOUR COMES FROM ───────────────────────────────────────────
//
// Nowhere in this file. `color` is passed in, and the only producer of it in
// the app is `techColorMap` in RouteMap.tsx, which delegates to the same
// `buildTechGroups` that paints the pins and the polylines. A second palette
// here would agree on the common case and drift the moment a tech has an empty
// day — the colour index advances only for techs who actually have visits —
// leaving a chip and its own pin in different colours, which is worse than
// having no colour at all.

/** "Brendan North" → "BN"; "Sam" → "SA"; nothing → "". Built from code points
 *  rather than UTF-16 units so a name starting with an astral character does
 *  not come back as half of one. */
export function techInitials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join("").toUpperCase();
  const first = [...parts[0]][0] ?? "";
  const last = [...parts[parts.length - 1]][0] ?? "";
  return (first + last).toUpperCase();
}

export function TechAvatar({
  name,
  color,
  className = "",
}: {
  /** `staff.display_name`. Null when the visit is unassigned. */
  name?: string | null;
  /** From `techColorMap`. Undefined for unassigned, and for anyone the map did
   *  not colour. */
  color?: string;
  className?: string;
}) {
  const initials = techInitials(name);
  return (
    <span
      // `title` rather than only the hover card, so the badge is readable on a
      // pointer without opening anything — and `aria-label` so it is readable
      // without a pointer at all. The chip's own accessible name (the client)
      // is the text beside it; this adds the person to it.
      title={name ?? "Nobody assigned yet"}
      aria-label={name ? `Assigned to ${name}` : "Unassigned"}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-3xs font-semibold leading-none ${
        color ? "text-white" : "border border-dashed border-current text-muted-foreground"
      } ${className}`}
      style={color ? { background: color } : undefined}
    >
      {initials}
    </span>
  );
}
