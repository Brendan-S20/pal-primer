/** The kinds of photo a tech can attach to a visit.
 *
 *  One list, because the same four words are the zod enum the upload is
 *  validated against, the database constraint
 *  (`visit_photos_kind_is_one_the_app_writes`), the offline queue's payload,
 *  and the two pickers. Each of those used to spell the union out by hand,
 *  which is how adding a kind means finding six places.
 *
 *  `gate` is the latched-gate photo: the answer to "did your tech close the
 *  gate?" after a dog gets out. It is sent to the customer with the
 *  completion email, and it does NOT count as the completion photo an org can
 *  require — a closed gate proves the yard was shut, not that it was cleaned. */
export const PHOTO_KINDS = ["completion", "before", "issue", "gate"] as const;

export type PhotoKind = (typeof PHOTO_KINDS)[number];

/** What the tech sees in the picker, in the order it is offered. */
export const PHOTO_KIND_OPTIONS: { value: PhotoKind; label: string }[] = [
  { value: "before", label: "Before" },
  { value: "completion", label: "Completion" },
  { value: "gate", label: "Home secured" },
  { value: "issue", label: "Issue" },
];

/** The photos a customer is sent when a visit is completed, in the order
 *  they appear in the email: the finished yard first, then the gate. */
export const PHOTO_KINDS_EMAILED: PhotoKind[] = ["completion", "gate"];

/** The staff-facing word for a stored kind; an unknown one is shown as-is. */
export function photoKindLabel(kind: string | null | undefined): string {
  return PHOTO_KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind ?? "";
}

/** Which of a visit's photos go in the completion email, as storage paths.
 *
 *  Up to three completion photos, oldest first, which is what the template
 *  has always drawn. And ONE gate photo, the newest: a tech who re-shoots the
 *  gate because the first was blurry, or who latched it a second time on the
 *  way out, means the last picture is the one that describes how it was left.
 *  Rows are expected oldest first. */
export function pickEmailedPhotos(rows: { storage_path: string; kind: string }[]): {
  completion: string[];
  gate: string | null;
} {
  const completion = rows
    .filter((r) => r.kind === "completion")
    .slice(0, 3)
    .map((r) => r.storage_path);
  const gates = rows.filter((r) => r.kind === "gate");
  return { completion, gate: gates.length ? gates[gates.length - 1].storage_path : null };
}

/** Default for a new photo, based on whether work has started. */
export function defaultPhotoKind(
  status: string | null | undefined,
  startedHere = false,
): PhotoKind {
  return startedHere || status === "in_progress" || status === "completed"
    ? "completion"
    : "before";
}
