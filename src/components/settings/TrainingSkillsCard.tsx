import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { listTrainingSkills, saveTrainingSkill } from "@/lib/training-progress.functions";

export function TrainingSkillsCard({ canEdit }: { canEdit: boolean }) {
  const list = useServerFn(listTrainingSkills);
  const saveFn = useServerFn(saveTrainingSkill);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["training-skills"], queryFn: () => list() });
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["training-skills"] });
  const save = useMutation({
    mutationFn: (input: { id?: string; name: string; active?: boolean }) => saveFn({ data: input }),
    onSuccess: () => {
      setName("");
      setEditing(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section
      className="space-y-4 rounded-lg border bg-card p-4 sm:p-6"
      data-testid="training-skills-settings"
    >
      <div className="min-w-0">
        <h3 className="font-semibold">Training skills</h3>
        <p className="text-sm text-muted-foreground">
          What a trainer scores after a lesson, from 1 to 5. Renaming a skill keeps the scores
          already recorded against it.
        </p>
      </div>
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading skills…</p>}
      {q.error && (
        <p role="alert" className="text-sm text-destructive">
          {q.error.message}
        </p>
      )}
      {q.data?.skills.length === 0 && (
        <p className="text-sm text-muted-foreground">No skills yet.</p>
      )}
      <ul className="space-y-3">
        {q.data?.skills.map((skill) => (
          <li
            key={skill.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0 flex-1">
              {editing?.id === skill.id ? (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const next = editing.name.trim();
                    if (!next) return;
                    save.mutate({ id: skill.id, name: next });
                  }}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <Label htmlFor={`skill-${skill.id}`}>Skill name</Label>
                    <Input
                      id={`skill-${skill.id}`}
                      value={editing.name}
                      maxLength={80}
                      onChange={(e) => setEditing({ id: skill.id, name: e.target.value })}
                      required
                    />
                  </div>
                  <Button type="submit" className="shrink-0" disabled={save.isPending}>
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </Button>
                </form>
              ) : (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <p className="min-w-0 break-words font-medium">{skill.name}</p>
                  <Badge variant="secondary">{skill.active ? "Active" : "Inactive"}</Badge>
                </div>
              )}
            </div>
            {canEdit && editing?.id !== skill.id && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => setEditing({ id: skill.id, name: skill.name })}
                >
                  Rename
                </Button>
                <Button
                  variant="outline"
                  disabled={save.isPending}
                  onClick={() =>
                    save.mutate({ id: skill.id, name: skill.name, active: !skill.active })
                  }
                >
                  {skill.active ? "Deactivate" : "Activate"}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const next = name.trim();
            if (!next) return;
            save.mutate({ name: next });
          }}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor="new-skill">Add a skill</Label>
            <Input
              id="new-skill"
              value={name}
              maxLength={80}
              placeholder="Place"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button type="submit" className="shrink-0" disabled={save.isPending || !name.trim()}>
            Add skill
          </Button>
        </form>
      )}
    </section>
  );
}
