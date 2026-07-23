// Shared multi-select state for list/table pages (the Invoices-page pattern):
// per-row checkboxes, a header select-all over the currently visible rows, and
// a bulk-action bar driven by `selectedIds`. Selection intentionally clears
// when `clearKey` changes (pass a string built from the page's filters) so a
// selection made under one filter never silently carries into another.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function useRowSelection(visibleIds: string[], clearKey?: unknown) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Clear on filter change, but not on mount (nothing is selected yet, and
  // firing on mount would loop if callers pass an unstable key).
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setSelected(new Set());
  }, [clearKey]);

  const selectedIds = useMemo(() => [...selected], [selected]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  const toggle = useCallback((id: string, next?: boolean) => {
    setSelected((prev) => {
      const on = next ?? !prev.has(id);
      if (on === prev.has(id)) return prev;
      const copy = new Set(prev);
      if (on) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const all = visibleIds.length > 0 && visibleIds.every((id) => prev.has(id));
      return all ? new Set<string>() : new Set(visibleIds);
    });
  }, [visibleIds]);

  const clear = useCallback(() => setSelected(new Set()), []);

  return {
    /** Ids currently selected (may include rows hidden by a later filter if no clearKey is passed). */
    selectedIds,
    count: selected.size,
    /** True when every currently visible row is selected. */
    allSelected,
    isSelected,
    toggle,
    toggleAll,
    clear,
  };
}
