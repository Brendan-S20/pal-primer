// Three completely separate note systems (spec): Internal Office Notes
// (office only, RLS-hidden from technicians), Technician Instructions
// (surfaced during visit execution), and Client Visible Notes (portal /
// email / SMS). Audience is chosen at creation and can never be changed —
// that's how accidental visibility flips are prevented.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Eye, Pin, PinOff, Trash2, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
  const delMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: invalidate,
    onError: (e) => toast.error((e as Error).message),
  });

  const active = AUDIENCES.find((a) => a.key === tab)!;
  const visible = notes.filter((n: any) => n.audience === tab);
  const countFor = (k: Audience) => notes.filter((n: any) => n.audience === k).length;

  return (
    <section className={compact ? "" : "rounded-lg border bg-card p-5"}>
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
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                tab === a.key ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
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
          <Wrench className="h-3 w-3" />
        ) : tab === "client" ? (
          <Eye className="h-3 w-3" />
        ) : null}
        {active.hint}
      </p>

      {isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {visible.map((n: any) => (
            <li key={n.id} className="rounded-md border p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <p className="whitespace-pre-wrap">{n.body}</p>
                <div className="flex shrink-0 items-center gap-1">
                  {n.pinned && (
                    <Badge variant="outline" className="text-[10px]">
                      Pinned
                    </Badge>
                  )}
                  <button
                    type="button"
                    aria-label={n.pinned ? "Unpin note" : "Pin note"}
                    onClick={() => pinMut.mutate({ id: n.id, pinned: !n.pinned })}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {n.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
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
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {new Date(n.created_at).toLocaleDateString()}
              </div>
            </li>
          ))}
          {visible.length === 0 && (
            <li className="rounded-md border border-dashed p-3 text-center text-sm text-muted-foreground">
              No {tab === "office" ? "office notes" : tab === "technician" ? "technician instructions" : "client-visible notes"} yet.
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
          rows={2}
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
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${active.tone}`}>
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
