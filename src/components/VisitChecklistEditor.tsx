import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { setEmailVisitChecklist, setVisitChecklist } from "@/lib/org-features.functions";
import {
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_LABEL,
  SUGGESTED_CHECKLIST,
  checklistProblem,
  newChecklistItemId,
  type ChecklistItem,
} from "@/lib/visit-checklist";

const same = (a: readonly ChecklistItem[], b: readonly ChecklistItem[]) =>
  a.length === b.length &&
  a.every((x, i) => x.id === b[i].id && x.label === b[i].label && x.required === b[i].required);

/**
 * The owner's visit checklist, edited next to the photo rule because both
 * answer the same question: what does finishing a visit ask of a tech?
 *
 * Edits are a draft until Save, so half-typing a label does not rewrite what
 * every tech's Complete button is waiting on. The one exception is the
 * suggested set, which is one tap by design: the owner who has never thought
 * about a checklist gets a sensible one without writing it.
 *
 * Ids are minted here and never change, which is what lets a rename keep
 * working for a completion already queued on a phone in a dead zone.
 */
export function VisitChecklistEditor({
  saved,
  emailOn,
  canEdit,
  loading,
}: {
  saved: ChecklistItem[];
  emailOn: boolean;
  canEdit: boolean;
  loading: boolean;
}) {
  const qc = useQueryClient();
  const saveFn = useServerFn(setVisitChecklist);
  const emailFn = useServerFn(setEmailVisitChecklist);
  const [draft, setDraft] = useState<ChecklistItem[]>(saved);
  const [open, setOpen] = useState(false);
  // Re-seed from the server when it changes underneath, but never over edits
  // the owner has not saved.
  const [base, setBase] = useState<ChecklistItem[]>(saved);
  useEffect(() => {
    if (same(saved, base)) return;
    setDraft((d) => (same(d, base) ? saved : d));
    setBase(saved);
  }, [saved, base]);

  const dirty = !same(draft, saved);
  const problem = checklistProblem(draft);
  const missingSuggestions = useMemo(
    () =>
      SUGGESTED_CHECKLIST.filter(
        (s) => !draft.some((d) => d.label.trim().toLowerCase() === s.label.toLowerCase()),
      ),
    [draft],
  );

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["my-org-features"] });
    // My Day reads the checklist from the shell's org query.
    qc.invalidateQueries({ queryKey: ["my-org"] });
  };
  const save = useMutation({
    mutationFn: (items: ChecklistItem[]) =>
      saveFn({ data: { items: items.map((i) => ({ ...i, label: i.label.trim() })) } }),
    onSuccess: (_r, items) => {
      setDraft(items.map((i) => ({ ...i, label: i.label.trim() })));
      setOpen(false);
      refresh();
      toast.success(
        items.length === 0
          ? "Checklist removed. Techs finish a visit without one."
          : `Checklist saved. Techs see ${items.length} item${items.length === 1 ? "" : "s"} on every visit.`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const email = useMutation({
    mutationFn: (enabled: boolean) => emailFn({ data: { enabled } }),
    onSuccess: (_r, enabled) => {
      qc.invalidateQueries({ queryKey: ["my-org-features"] });
      toast.success(
        enabled
          ? "The completion email now lists what the tech checked."
          : "The completion email no longer lists the checklist.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const busy = !canEdit || loading || save.isPending;
  const update = (id: string, patch: Partial<ChecklistItem>) =>
    setDraft((d) => d.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const addSuggested = () => {
    const room = MAX_CHECKLIST_ITEMS - draft.length;
    const next = [
      ...draft,
      ...missingSuggestions.slice(0, Math.max(0, room)).map((s) => ({
        id: newChecklistItemId(),
        label: s.label,
        required: s.required,
      })),
    ];
    const why = checklistProblem(next);
    if (why) {
      setDraft(next);
      toast.error(why);
      return;
    }
    save.mutate(next);
  };

  // Folded to a summary until asked for. Preferences was once four screens of
  // unrelated settings (tests/viewports/preferences-was-a-dumping-ground), and
  // twelve rows of text fields that are edited once a season should not make
  // it five. Unsaved edits keep it open, so a half-written list cannot hide.
  if (!open && !dirty && saved.length > 0) {
    // One row: the summary and the way in. Not the labels themselves, which
    // are the tech's to read on My Day and the owner's to read in the editor.
    const required = saved.filter((i) => i.required).length;
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Visit checklist</div>
          <div className="text-xs text-muted-foreground">
            {saved.length} item{saved.length === 1 ? "" : "s"}, {required} required
            {emailOn ? ", in the completion email" : ""}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-11 shrink-0"
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          Edit checklist
        </Button>
      </div>
    );
  }
  if (!open && !dirty) {
    // No checklist yet: the suggested set is one tap from here.
    return (
      <div className="space-y-3 border-t pt-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">Visit checklist</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Nothing for a tech to confirm yet. Add a checklist and they tick it off before
            completing every visit. Suggested: {SUGGESTED_CHECKLIST.map((s) => s.label).join(", ")}.
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" className="h-11" disabled={busy} onClick={addSuggested}>
            Add suggested checklist
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={busy}
            onClick={() => {
              setOpen(true);
              setDraft([{ id: newChecklistItemId(), label: "", required: true }]);
            }}
          >
            Write your own
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <div className="text-sm font-medium">Visit checklist</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          What a tech confirms before completing every visit. Required items must be checked to
          finish; the answers are kept on the visit, worded as they were that day.
        </div>
      </div>

      {draft.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No checklist. Techs finish a visit with a photo and an optional note.
        </p>
      ) : (
        <ul className="space-y-2">
          {draft.map((item, n) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Input
                aria-label={`Checklist item ${n + 1}`}
                className="h-11 min-w-0 flex-1 basis-full sm:basis-0"
                maxLength={MAX_CHECKLIST_LABEL}
                value={item.label}
                disabled={busy}
                placeholder="Gate latched"
                onChange={(e) => update(item.id, { label: e.target.value })}
              />
              <label
                htmlFor={`checklist-required-${item.id}`}
                className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2 px-1 text-sm"
              >
                <Checkbox
                  id={`checklist-required-${item.id}`}
                  checked={item.required}
                  disabled={busy}
                  onCheckedChange={(v) => update(item.id, { required: v === true })}
                />
                Required
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-auto h-11 w-11 shrink-0"
                disabled={busy}
                aria-label={`Remove ${item.label || `item ${n + 1}`}`}
                onClick={() => setDraft((d) => d.filter((i) => i.id !== item.id))}
              >
                <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={busy || draft.length >= MAX_CHECKLIST_ITEMS}
          onClick={() =>
            setDraft((d) => [...d, { id: newChecklistItemId(), label: "", required: true }])
          }
        >
          <Plus className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" />
          Add item
        </Button>
        {missingSuggestions.length > 0 && (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={busy || draft.length >= MAX_CHECKLIST_ITEMS}
            onClick={addSuggested}
          >
            Add suggested items
          </Button>
        )}
        {!dirty && (
          <Button type="button" variant="ghost" className="h-11" onClick={() => setOpen(false)}>
            Done
          </Button>
        )}
      </div>
      {missingSuggestions.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Suggested: {missingSuggestions.map((s) => s.label).join(", ")}.
        </p>
      )}

      {dirty && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            className="h-11"
            disabled={busy || !!problem}
            onClick={() => save.mutate(draft)}
          >
            {save.isPending ? "Saving…" : "Save checklist"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-11"
            disabled={save.isPending}
            onClick={() => setDraft(saved)}
          >
            Discard changes
          </Button>
          {problem && <p className="w-full text-xs text-destructive">{problem}</p>}
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="email-visit-checklist" className="text-sm font-medium">
            Show the checklist in the completion email
          </Label>
          <div className="mt-0.5 text-xs text-muted-foreground">
            The customer sees the items the tech checked. Off: the checklist stays between you and
            your techs.
          </div>
        </div>
        <Switch
          id="email-visit-checklist"
          checked={emailOn}
          disabled={!canEdit || loading || email.isPending}
          onCheckedChange={(v) => email.mutate(v)}
        />
      </div>
    </div>
  );
}
