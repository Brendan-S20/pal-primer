// Ask before leaving a page that holds unsaved changes (#1043-3).
import { useBlocker } from "@tanstack/react-router";
import { useConfirmDialog } from "@/components/ConfirmDialog";

/** While `dirty`, leaving the page asks first, and so does closing or reloading
 *  the tab (the browser's own prompt). Render the returned `dialog`. */
export function useUnsavedChangesGuard(dirty: boolean) {
  const { confirm, dialog } = useConfirmDialog();
  useBlocker({
    disabled: !dirty,
    enableBeforeUnload: dirty,
    shouldBlockFn: async ({ current, next }) => {
      // A change of search or hash keeps the page, and what is typed on it.
      if (current.pathname === next.pathname) return false;
      const leave = await confirm({
        title: "Leave without saving?",
        description: "Your changes on this page have not been saved.",
        confirmLabel: "Leave without saving",
        cancelLabel: "Stay on this page",
        destructive: true,
      });
      return !leave;
    },
  });
  return { dialog };
}
