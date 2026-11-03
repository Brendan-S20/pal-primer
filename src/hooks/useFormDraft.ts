import { useCallback, useEffect, useRef, useState } from "react";
import { useMyRole } from "@/hooks/useMyRole";
import { resolveOfflineUserId } from "@/lib/offline/action-owner";
import {
  clearFormDraft,
  draftDiffers,
  formDraftKey,
  loadFormDraft,
  saveFormDraft,
} from "@/lib/form-drafts";

/**
 * Keep a form's values on the device as they are typed (gaps-r2-12), per
 * signed-in user and organization (lib/form-drafts.ts).
 *
 * The same contract as useWalkReport (#610): nothing is written until the
 * saved draft has been read, so an empty first render never overwrites it;
 * a form the person started typing in before the draft arrived keeps what
 * they typed. A value equal to the one the form opened with is not a draft,
 * so opening a form and leaving it never offers anything back.
 *
 * `restore` is called at most once, with the saved value. `clear()` is for a
 * successful save: the draft is dropped and nothing more is written.
 * `discard()` is the "Discard draft" button: the draft is dropped and the
 * form goes back to how it opened, through `reset`.
 */
export function useFormDraft<T>(opts: {
  form: string;
  value: T;
  restore: (draft: T) => void;
  reset: () => void;
}): { restored: boolean; clear: () => void; discard: () => void } {
  const { orgId } = useMyRole();
  const [userId, setUserId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [restored, setRestored] = useState(false);
  const done = useRef(false);
  const serialized = JSON.stringify(opts.value);
  const initial = useRef(serialized);
  const latest = useRef(opts);
  latest.current = opts;

  useEffect(() => {
    let live = true;
    resolveOfflineUserId()
      .then((id) => live && setUserId(id))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const key = formDraftKey(userId, orgId, opts.form);

  useEffect(() => {
    if (!key || hydrated) return;
    const draft = loadFormDraft<T>(key);
    // Typed into before the draft arrived: what is on screen wins.
    const untouched = JSON.stringify(latest.current.value) === initial.current;
    if (draft && untouched) {
      latest.current.restore(draft);
      setRestored(true);
    }
    setHydrated(true);
  }, [key, hydrated]);

  useEffect(() => {
    if (!hydrated || done.current || !key) return;
    if (draftDiffers(initial.current, serialized)) saveFormDraft(key, JSON.parse(serialized));
    else clearFormDraft(key);
  }, [hydrated, key, serialized]);

  const clear = useCallback(() => {
    done.current = true;
    clearFormDraft(key);
    setRestored(false);
  }, [key]);

  const discard = useCallback(() => {
    clearFormDraft(key);
    setRestored(false);
    latest.current.reset();
  }, [key]);

  return { restored, clear, discard };
}
