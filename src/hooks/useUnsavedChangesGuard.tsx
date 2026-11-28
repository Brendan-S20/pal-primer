// Ask before leaving a page that holds unsaved changes (#1043-3).
import { useEffect, useRef } from "react";
import { useBlocker } from "@tanstack/react-router";
import { useConfirmDialog } from "@/components/ConfirmDialog";

/** One per page that is dirty right now. Resolves true to leave. */
const askers = new Set<() => Promise<boolean>>();
/** Already asked and answered: the way out must not ask a second time. */
let letGo = false;

/** Wrap anything that ends the session and then leaves the page. The question
 *  has to come first: asked by the router or the browser on the way to /auth,
 *  "stay" would keep a signed-in looking page with no session behind it.
 *  `end` resolves true when the session ended; false means nothing ran. */
export async function endSessionAfterAsking(end: () => Promise<boolean>): Promise<boolean> {
  for (const ask of askers) if (!(await ask())) return false;
  letGo = true;
  let ended = false;
  try {
    ended = await end();
  } finally {
    // Still here and signed in, so the page is guarded again.
    if (!ended) letGo = false;
  }
  return ended;
}

/** While `dirty`, leaving the page asks first, and so does closing or reloading
 *  the tab (the browser's own prompt). Render the returned `dialog`. */
export function useUnsavedChangesGuard(dirty: boolean) {
  const { confirm, dialog } = useConfirmDialog();
  const ask = () =>
    confirm({
      title: "Leave without saving?",
      description: "Your changes on this page have not been saved.",
      confirmLabel: "Leave without saving",
      cancelLabel: "Stay on this page",
      destructive: true,
    });
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    if (!dirty) return;
    letGo = false;
    const asker = () => askRef.current();
    askers.add(asker);
    return () => void askers.delete(asker);
  }, [dirty]);
  useBlocker({
    disabled: !dirty,
    // A function, so the browser's prompt reads the answer as of the unload.
    enableBeforeUnload: () => dirty && !letGo,
    shouldBlockFn: async ({ current, next }) => {
      // A change of search or hash keeps the page, and what is typed on it.
      if (letGo || current.pathname === next.pathname) return false;
      return !(await ask());
    },
  });
  return { dialog };
}
