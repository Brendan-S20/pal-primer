// Three completely separate note systems (spec): Internal Office Notes
// (office only, RLS-hidden from technicians), Technician Instructions
// (surfaced during visit execution), and Client Visible Notes (portal /
// email / SMS). Audience is chosen at creation and can never be changed —
// that's how accidental visibility flips are prevented.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, Eye, Pencil, Pin, PinOff, StickyNote, Trash2, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, MetaChip } from "@/components/client-detail/primitives";
import { formatDateTime } from "@/lib/format";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import {
  listClientNotes,
  createClientNote,
  updateClientNote,
  deleteClientNote,
} from "@/lib/client-notes.functions";

type Audience = "office" | "technician" | "client";

const AUDIENCES: Array<{
  key: Audience;
  label: string;
  hint: string;
  tone: string;
}> = [
  {
    key: "office",
    label: "Internal office notes",
    hint: "Only office staff see these. Billing quirks, reminders, follow-ups.",
    tone: "bg-muted text-muted-foreground",
  },
  {
    key: "technician",
    label: "Technician instructions",
    hint: "Technicians see these during visits. Gate, parking, dog behavior, hazards.",
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  {
    key: "client",
    label: "Client visible notes",
    hint: "The client sees these in their portal and messages. Write accordingly.",
    tone: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
];

export function NotesPanel({
  clientId,
  defaultAudience = "office",
  compact = false,
}: {
  clientId: string;
  defaultAudience?: Audience;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const listFn = useServerFn(listClientNotes);
  const createFn = useServerFn(createClientNote);
  const updateFn = useServerFn(updateClientNote);
  const deleteFn = useServerFn(deleteClientNote);

  const { data, isLoading } = useQuery({
    queryKey: ["client-notes", clientId],
    queryFn: () => listFn({ data: { clientId } }),
  });
  const notes = data?.notes ?? [];

  const [tab, setTab] = useState<Audience>(defaultAudience);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  // Composer collapses to a single line until focused (spec 3.4).
  const [composerFocused, setComposerFocused] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["client-notes", clientId] });

  const addMut = useMutation({
    mutationFn: () => createFn({ data: { clientId, audience: tab, body: draft.trim() } }),
    onSuccess: () => {
      setDraft("");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const pinMut = useMutation({
    mutationFn: (v: { id: string; pinned: boolean }) => updateFn({ data: v }),
    onSuccess: invalidate,
    onError: (e) => toast.error((e as Error).message),
  });
  const editMut = useMutation({
    mutationFn: (v: { id: string; body: string }) => updateFn({ data: v }),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: invalidate,
    onError: (e) => toast.error((e as Error).message),
  });

  const active = AUDIENCES.find((a) => a.key === tab)!;
  const visible = notes.filter((n: any) => n.audience === tab);
  const countFor = (k: Audience) => notes.filter((n: any) => n.audience === k).length;

  return (
    <section className={compact ? "" : "rounded-lg border bg-card shadow-sm p-5"}>
      {dialog}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Notes</h2>
        <div className="flex gap-1" role="tablist" aria-label="Note visibility">
          {AUDIENCES.map((a) => (
            <button
              key={a.key}
              role="tab"
              aria-selected={tab === a.key}
              onClick={() => setTab(a.key)}
              // 24.0px measured. A segmented control is a control, not prose,
              // so it takes the height directly.
              className={`inline-flex min-h-11 items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                tab === a.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              {a.key === "office" ? "Office" : a.key === "technician" ? "Technician" : "Client"}
              {countFor(a.key) > 0 && <span className="ml-1 opacity-70">{countFor(a.key)}</span>}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {tab === "technician" ? (
          <Wrench className="h-3 w-3 shrink-0" />
        ) : tab === "client" ? (
          <Eye className="h-3 w-3 shrink-0" />
        ) : null}
        {active.hint}
      </p>

      {isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {visible.map((n: any) => {
            const editingNote = editing?.id === n.id ? editing : null;
            return (
              <li key={n.id} className="rounded-md border p-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  {editingNote ? (
                    <div className="min-w-0 flex-1 space-y-2">
                      <Textarea
                        value={editingNote.body}
                        onChange={(e) => setEditing({ id: n.id, body: e.target.value })}
                        rows={3}
                        maxLength={4000}
                        autoFocus
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(null)}
                        >
                          <X className="mr-1.5 h-3.5 w-3.5 shrink-0" /> Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={editMut.isPending || !editingNote.body.trim()}
                          onClick={() =>
                            editMut.mutate({ id: n.id, body: editingNote.body.trim() })
                          }
                        >
                          <Check className="mr-1.5 h-3.5 w-3.5 shrink-0" />
                          {editMut.isPending ? "Saving..." : "Save"}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap">{n.body}</p>
                  )}
                  <div className="flex shrink-0 items-center gap-1">
                    {n.pinned && <MetaChip>Pinned</MetaChip>}
                    {!editingNote && (
                      <button
                        type="button"
                        aria-label="Edit note"
                        onClick={() => setEditing({ id: n.id, body: n.body })}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="h-3.5 w-3.5 shrink-0" />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={n.pinned ? "Unpin note" : "Pin note"}
                      onClick={() => pinMut.mutate({ id: n.id, pinned: !n.pinned })}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {n.pinned ? (
                        <PinOff className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <Pin className="h-3.5 w-3.5 shrink-0" />
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label="Delete note"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: "Delete this note?",
                            destructive: true,
                            confirmLabel: "Delete note",
                          })
                        )
                          delMut.mutate(n.id);
                      }}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5 shrink-0" />
                    </button>
                  </div>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatDateTime(n.created_at)}
                </div>
              </li>
            );
          })}
          {visible.length === 0 && (
            <li>
              <EmptyState
                compact
                icon={StickyNote}
                title={`No ${tab === "office" ? "office notes" : tab === "technician" ? "technician instructions" : "client-visible notes"} yet`}
                description={active.hint}
              />
            </li>
          )}
        </ul>
      )}

      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) addMut.mutate();
        }}
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setComposerFocused(true)}
          onBlur={() => setComposerFocused(false)}
          rows={composerFocused || draft ? 3 : 1}
          maxLength={4000}
          placeholder={
            tab === "office"
              ? "Add an internal office note…"
              : tab === "technician"
                ? "Add instructions technicians will see during visits…"
                : "Add a note the client will see…"
          }
        />
        <div className="flex items-center justify-between">
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${active.tone}`}>
            Saving to: {active.label}
          </span>
          <Button type="submit" size="sm" disabled={addMut.isPending || !draft.trim()}>
            {addMut.isPending ? "Adding…" : "Add note"}
          </Button>
        </div>
      </form>
    </section>
  );
}
