import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { setEmailVisitChecklist, setVisitChecklist } from "@/lib/org-features.functions";
import {
  MAX_CHECKLIST_LABEL,
  checklistForLine,
  checklistProblem,
  checklistRoom,
  newChecklistItemId,
  type ChecklistItem,
} from "@/lib/visit-checklist";
import {
  SERVICE_LINE_LABEL,
  checklistGroupsFor,
  checklistSuggestionsFor,
  type ServiceLine,
} from "@/lib/service-lines";
import { useServiceLines } from "@/components/CommercialOnly";

const same = (a: readonly ChecklistItem[], b: readonly ChecklistItem[]) =>
  a.length === b.length &&
  a.every(
    (x, i) =>
      x.id === b[i].id &&
      x.label === b[i].label &&
      x.required === b[i].required &&
      x.line === b[i].line,
  );

/** The Select's value for "every visit": Radix refuses an empty string. */
const EVERY = "every";

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
 *
 * A business that runs more than one line sees the list in groups (#565):
 * the items for every visit, then each line's. A walk is asked the first
 * group and the walking group, never the pet-waste one, and complete_visit
 * asks the same. Suggested items are saved with their line, so a business
 * that adds a line later is not asked to bag waste on a walk.
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

  // The one-tap set for what this business runs. For a pet-waste business it
  // is exactly the list it always was (LINE_SEEDS.pet_waste is
  // SUGGESTED_CHECKLIST, and a test holds them identical).
  const { lines } = useServiceLines();
  const groups = useMemo(() => checklistGroupsFor(draft, lines), [draft, lines]);
  const grouped = groups !== null;
  const groupLines = (groups ?? []).flatMap((g) => (g.line ? [g.line] : []));
  // One line: suggestedChecklistFor(lines), each saved with that line.
  const suggested = useMemo(() => checklistSuggestionsFor(lines), [lines]);
  const dirty = !same(draft, saved);
  const problem = checklistProblem(draft);
  // A suggestion is missing when no item a visit of its line is asked already
  // reads the same.
  const missingSuggestions = useMemo(
    () =>
      suggested.filter(
        (s) =>
          !(s.line ? checklistForLine(draft, s.line) : draft).some(
            (d) => d.label.trim().toLowerCase() === s.label.toLowerCase(),
          ),
      ),
    [draft, suggested],
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
          : grouped
            ? "Checklist saved. Each visit asks its own service's items and the ones for every visit."
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

  // Every missing suggestion, or one line's. Each is saved with its line.
  const addSuggested = (only?: ServiceLine) => {
    const next = [...draft];
    for (const s of missingSuggestions) {
      if (only && s.line !== only) continue;
      if (checklistRoom(next, s.line) === 0) continue;
      next.push({ id: newChecklistItemId(), label: s.label, required: s.required, line: s.line });
    }
    const why = checklistProblem(next);
    if (why) {
      setDraft(next);
      toast.error(why);
      return;
    }
    save.mutate(next);
  };

  const addItem = (line: ServiceLine | undefined) =>
    setDraft((d) => [
      ...d,
      { id: newChecklistItemId(), label: "", required: true, ...(line ? { line } : {}) },
    ]);

  // One row per item: the label, which line asks it (only when there is more
  // than one), required, remove. Wraps rather than widening the card.
  const itemRows = (items: ChecklistItem[]) =>
    items.length === 0 ? null : (
      <ul className="space-y-2">
        {items.map((item) => {
          const n = draft.indexOf(item);
          return (
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
              {grouped && (
                <Select
                  value={item.line ?? EVERY}
                  disabled={busy}
                  onValueChange={(v) =>
                    update(item.id, { line: v === EVERY ? undefined : (v as ServiceLine) })
                  }
                >
                  <SelectTrigger
                    aria-label={`Which visits ask ${item.label || `item ${n + 1}`}`}
                    className="h-11 w-auto min-w-0 max-w-full shrink"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={EVERY}>Every visit</SelectItem>
                    {groupLines.map((l) => (
                      <SelectItem key={l} value={l}>
                        {SERVICE_LINE_LABEL[l]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
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
          );
        })}
      </ul>
    );

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
            completing every visit.{" "}
            {grouped
              ? "Each service gets its own suggested items."
              : `Suggested: ${suggested.map((s) => s.label).join(", ")}.`}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" className="h-11" disabled={busy} onClick={() => addSuggested()}>
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
      ) : groups ? (
        <div className="space-y-4">
          {groups.map(({ line, items }) => (
            <ChecklistGroup
              key={line ?? EVERY}
              title={line ? SERVICE_LINE_LABEL[line] : "Every visit"}
              hint={
                line
                  ? `Asked on ${SERVICE_LINE_LABEL[line].toLowerCase()} visits only.`
                  : "Asked on every visit, whatever the service."
              }
            >
              {itemRows(items)}
              {line && (
                <div className="flex flex-wrap gap-2">
                  <AddItemButton
                    disabled={busy || checklistRoom(draft, line) === 0}
                    onClick={() => addItem(line)}
                  />
                  {missingSuggestions.some((s) => s.line === line) && (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11"
                      disabled={busy || checklistRoom(draft, line) === 0}
                      onClick={() => addSuggested(line)}
                    >
                      Add suggested items
                    </Button>
                  )}
                </div>
              )}
            </ChecklistGroup>
          ))}
        </div>
      ) : (
        itemRows(draft)
      )}

      <div className="flex flex-wrap gap-2">
        <AddItemButton
          label={grouped ? "Add item for every visit" : "Add item"}
          disabled={busy || checklistRoom(draft) === 0}
          onClick={() => addItem(undefined)}
        />
        {!grouped && missingSuggestions.length > 0 && (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={busy || checklistRoom(draft, lines[0]) === 0}
            onClick={() => addSuggested()}
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
      {!grouped && missingSuggestions.length > 0 && (
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
            The client sees the items the tech checked. Off: the checklist stays between you and
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

function ChecklistGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 rounded-md border p-3">
      <div className="min-w-0">
        <h4 className="text-sm font-medium">{title}</h4>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function AddItemButton({
  label = "Add item",
  disabled,
  onClick,
}: {
  label?: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button type="button" variant="outline" className="h-11" disabled={disabled} onClick={onClick}>
      <Plus className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {label}
    </Button>
  );
}
