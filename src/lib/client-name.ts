type ClientNameInput = {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
};

type StoredClientName = {
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
};

export function cleanClientNamePart(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function splitDisplayNameForPerson(displayName: unknown): {
  firstName: string;
  lastName: string;
} {
  const clean = cleanClientNamePart(displayName);
  if (!clean) return { firstName: "", lastName: "" };

  const parts = clean.split(" ");
  if (parts.length === 1) return { firstName: clean, lastName: "" };

  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

export function clientNameFormDefaults(client: StoredClientName | null | undefined): {
  firstName: string;
  lastName: string;
  company: string;
} {
  const company = cleanClientNamePart(client?.company);
  const firstName = cleanClientNamePart(client?.first_name);
  const lastName = cleanClientNamePart(client?.last_name);

  if (firstName || lastName || company) return { firstName, lastName, company };

  return {
    ...splitDisplayNameForPerson(client?.display_name),
    company,
  };
}

export function buildClientNamePatch(
  input: ClientNameInput,
  existing: StoredClientName | null | undefined,
): { patch: Record<string, unknown>; changed: boolean } {
  const hasStructuredName =
    input.firstName !== undefined || input.lastName !== undefined || input.company !== undefined;

  if (!hasStructuredName) {
    const displayName = cleanClientNamePart(input.displayName);
    return displayName
      ? { patch: { display_name: displayName }, changed: true }
      : { patch: {}, changed: false };
  }

  const firstName = cleanClientNamePart(input.firstName);
  const lastName = cleanClientNamePart(input.lastName);
  const company = cleanClientNamePart(input.company);
  const displayName = cleanClientNamePart(input.displayName);

  if (
    !firstName &&
    !lastName &&
    !company &&
    !displayName &&
    cleanClientNamePart(existing?.display_name)
  ) {
    return { patch: {}, changed: false };
  }

  const patch: Record<string, unknown> = {};
  if (input.firstName !== undefined) patch.first_name = firstName || null;
  if (input.lastName !== undefined) patch.last_name = lastName || null;
  if (input.company !== undefined) patch.company = company || null;

  const person = [firstName, lastName].filter(Boolean).join(" ").trim();
  const derived = person || company || displayName;
  if (derived) patch.display_name = derived;

  return { patch, changed: Object.keys(patch).length > 0 };
}
