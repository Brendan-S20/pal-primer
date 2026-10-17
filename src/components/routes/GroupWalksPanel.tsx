import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Plus, Trash2, X } from "lucide-react";
import { useServiceLines } from "@/components/CommercialOnly";
import { useOrgServices } from "@/components/client-detail/ServicePicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDay, formatWindow } from "@/lib/format";
import type { Service } from "@/lib/services";
import type { WalkGroupSummary, WalkGroupVisit } from "@/lib/walk-groups";
import {
  createWalkGroup,
  deleteWalkGroup,
  listWalkGroups,
  setWalkGroupMember,
  setWalkGroupWalker,
} from "@/lib/walk-groups.functions";

type Walker = { id: string; display_name: string | null; is_field_tech: boolean };
type Props = { day: string; staff: Walker[]; onChanged: () => void };
const selectClass = "min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm";

export function GroupWalksPanel(props: Props) {
  const { lines, known } = useServiceLines();
  const walking = known && lines.includes("dog_walking");
  const { services } = useOrgServices(walking);
  const groupServices = services.filter(
    (service) =>
      service.active && service.service_line === "dog_walking" && service.max_dogs != null,
  );
  if (!walking || groupServices.length === 0) return null;
  return <GroupWalksDay key={props.day} {...props} services={groupServices} />;
}

function GroupWalksDay({ day, staff, services, onChanged }: Props & { services: Service[] }) {
  const qc = useQueryClient();
  const list = useServerFn(listWalkGroups);
  const create = useServerFn(createWalkGroup);
  const remove = useServerFn(deleteWalkGroup);
  const member = useServerFn(setWalkGroupMember);
  const walker = useServerFn(setWalkGroupWalker);
  const [creating, setCreating] = useState(false);
  const [serviceId, setServiceId] = useState(services[0].id);
  const [walkerId, setWalkerId] = useState("");
  const [earliest, setEarliest] = useState("");
  const [latest, setLatest] = useState("");
  const walkers = staff.filter((person) => person.is_field_tech);
  const query = useQuery({
    queryKey: ["visits", "walk-groups", day],
    queryFn: () => list({ data: { day } }),
  });
  const write = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["visits"] });
      onChanged();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <section className="min-w-0 space-y-4 rounded-lg border bg-card p-4" aria-label="Group walks">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">Group walks</h2>
          <p className="text-sm text-muted-foreground">{formatDay(day)}</p>
        </div>
        <Button
          variant="outline"
          className="min-h-11 shrink-0"
          onClick={() => setCreating(!creating)}
        >
          <Plus className="h-4 w-4 shrink-0" />
          {creating ? "Close form" : "Create group"}
        </Button>
      </div>

      {creating && (
        <form
          className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            write.mutate(async () => {
              await create({
                data: {
                  day,
                  serviceId,
                  walkerId: walkerId || null,
                  earliestTime: earliest || null,
                  latestTime: latest || null,
                },
              });
              setCreating(false);
            });
          }}
        >
          <div className="min-w-0 space-y-1">
            <Label htmlFor="group-service">Service</Label>
            <select
              id="group-service"
              className={selectClass}
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
            >
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}, up to {service.max_dogs} dogs
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor="group-walker">Walker (optional)</Label>
            <select
              id="group-walker"
              className={selectClass}
              value={walkerId}
              onChange={(e) => setWalkerId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {walkers.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor="group-earliest">Earliest arrival (optional)</Label>
            <Input
              id="group-earliest"
              className="min-h-11 min-w-0"
              type="time"
              value={earliest}
              onChange={(e) => setEarliest(e.target.value)}
            />
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor="group-latest">Latest arrival (optional)</Label>
            <Input
              id="group-latest"
              className="min-h-11 min-w-0"
              type="time"
              value={latest}
              onChange={(e) => setLatest(e.target.value)}
            />
          </div>
          <Button type="submit" className="min-h-11 justify-self-start" disabled={write.isPending}>
            Create group walk
          </Button>
        </form>
      )}

      {query.isLoading && <p className="text-sm text-muted-foreground">Loading group walks...</p>}
      {query.error && (
        <p role="alert" className="text-sm text-destructive">
          {query.error.message}
        </p>
      )}
      {query.data?.groups.length === 0 && (
        <p className="text-sm text-muted-foreground">No group walks for this day.</p>
      )}
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        {query.data?.groups.map((group) => (
          <GroupWalkCard
            key={group.id}
            group={group}
            walkers={walkers}
            available={(query.data?.available ?? []).filter(
              (visit) => visit.serviceId === group.serviceId,
            )}
            pending={write.isPending}
            onWalker={(id) =>
              write.mutate(() => walker({ data: { groupId: group.id, walkerId: id } }))
            }
            onMember={(visitId, joining) =>
              write.mutate(() => member({ data: { visitId, groupId: joining ? group.id : null } }))
            }
            onDelete={() => write.mutate(() => remove({ data: { groupId: group.id } }))}
          />
        ))}
      </div>
    </section>
  );
}

function GroupWalkCard({
  group,
  walkers,
  available,
  pending,
  onWalker,
  onMember,
  onDelete,
}: {
  group: WalkGroupSummary;
  walkers: Walker[];
  available: WalkGroupVisit[];
  pending: boolean;
  onWalker: (id: string | null) => void;
  onMember: (id: string, joining: boolean) => void;
  onDelete: () => void;
}) {
  const [visitId, setVisitId] = useState("");
  const dogs = group.members.reduce((sum, visit) => sum + visit.dogCount, 0);
  return (
    <article className="min-w-0 space-y-3 rounded-md border p-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium" title={group.service}>
            {group.service}
          </h3>
          <p className="text-sm text-muted-foreground">
            {formatWindow(group.earliestTime, group.latestTime)}
          </p>
          <p className="text-sm">
            {dogs} of {group.maxDogs} dogs
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 shrink-0"
          disabled={pending}
          aria-label={`Delete ${group.service} group`}
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4 shrink-0" />
        </Button>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`walker-${group.id}`}>Walker</Label>
        <select
          id={`walker-${group.id}`}
          className={selectClass}
          value={group.walkerId ?? ""}
          disabled={pending}
          onChange={(e) => onWalker(e.target.value || null)}
        >
          <option value="">Unassigned</option>
          {walkers.map((person) => (
            <option key={person.id} value={person.id}>
              {person.display_name}
            </option>
          ))}
        </select>
      </div>
      <ul className="space-y-2">
        {group.members.map((visit) => (
          <li key={visit.id} className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium" title={visit.client}>
                {visit.client}
              </p>
              <p className="break-words text-xs text-muted-foreground">
                {visit.dogs.join(", ") || "No dog names recorded"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11 shrink-0"
              aria-label={`Remove ${visit.client} from group`}
              disabled={pending || visit.status !== "scheduled"}
              onClick={() => onMember(visit.id, false)}
            >
              <X className="h-4 w-4 shrink-0" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="space-y-1">
        <Label htmlFor={`member-${group.id}`}>Add a scheduled walk</Label>
        <div className="flex min-w-0 flex-wrap gap-2">
          <select
            id={`member-${group.id}`}
            className={`${selectClass} flex-1 basis-40`}
            value={visitId}
            disabled={pending || available.length === 0}
            onChange={(e) => setVisitId(e.target.value)}
          >
            <option value="">{available.length ? "Choose a walk" : "No available walks"}</option>
            {available.map((visit) => (
              <option key={visit.id} value={visit.id}>
                {visit.client}: {visit.dogs.join(", ") || `${visit.dogCount} dogs`}
              </option>
            ))}
          </select>
          <Button
            className="min-h-11 shrink-0"
            disabled={pending || !available.some((visit) => visit.id === visitId)}
            onClick={() => {
              onMember(visitId, true);
              setVisitId("");
            }}
          >
            Add walk
          </Button>
        </div>
      </div>
    </article>
  );
}
