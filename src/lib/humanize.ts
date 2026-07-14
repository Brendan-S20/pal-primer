// Shared "humanize" layer (QA finding #19): admin-facing surfaces were rendering
// raw backend values — snake_case role enums ("office_manager"), DB table names,
// and internal roadmap notes — directly to users. Route labels through here so
// they read as product copy everywhere. The tenant Settings → Users & roles page
// is the reference for role labels.

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  office_manager: "Office manager",
  dispatcher: "Dispatcher",
  tech: "Technician",
  platform_admin: "Platform admin",
};

/** Human-readable label for a role enum value. */
export function humanizeRole(role: string | null | undefined): string {
  if (!role) return "-";
  return ROLE_LABELS[role] ?? humanizeEnum(role);
}

/** Generic snake_case → "Sentence case" for any unmapped enum value. */
export function humanizeEnum(value: string | null | undefined): string {
  if (!value) return "-";
  const spaced = value.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
