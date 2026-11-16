import { useEffect, useState } from "react";
import { useMyRole } from "@/hooks/useMyRole";
import { resolveOfflineUserId } from "@/lib/offline/action-owner";
import { formDraftKey, loadFormDraft } from "@/lib/form-drafts";
import type { SetupAreaPriceDraft } from "@/lib/new-zone-defaults";

/** The form name setup's service-area step keeps its draft under. */
export const SETUP_AREA_DRAFT_FORM = "setup-area";

/**
 * The price an owner typed into setup's service-area step on this device and
 * did not get to save (#914, after #881). Read only: the draft is setup's, and
 * setup clears it when the area saves. Undefined until it has been read, null
 * when there is none.
 */
export function useSetupAreaPriceDraft(enabled: boolean): SetupAreaPriceDraft | undefined {
  const { orgId } = useMyRole();
  const [userId, setUserId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SetupAreaPriceDraft | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    resolveOfflineUserId()
      .then((id) => live && setUserId(id))
      .catch(() => live && setDraft(null));
    return () => {
      live = false;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !userId) return;
    const key = formDraftKey(userId, orgId, SETUP_AREA_DRAFT_FORM);
    if (!key) return;
    setDraft(loadFormDraft<{ price?: unknown; extraDog?: unknown }>(key) ?? null);
  }, [enabled, userId, orgId]);

  return draft;
}
