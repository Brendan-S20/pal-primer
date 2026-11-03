// What Cancel on an import preview asks before it throws the preview away.
// It was one tap with no question and no undo (R2-32, uxqa-r2-07). Nothing
// was written to clients yet, so the question says that too: canceling loses
// the mapping and the preview, not any data.
export const IMPORT_CANCEL_CONFIRM = {
  title: "Cancel this import?",
  description:
    "Nothing from this file has been added yet. Canceling throws away this preview and its column mapping, and it cannot be undone. To import the file later, upload it again.",
  confirmLabel: "Cancel import",
  cancelLabel: "Keep the preview",
  destructive: true,
} as const;
