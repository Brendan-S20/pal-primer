import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { CalendarClock, CalendarPlus, GraduationCap, NotebookPen, ShoppingBag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePortalCtx, EmptyBox, fmtDayShort, money } from "@/lib/portal-ui";
import {
  portalBuyTrainingPackage,
  portalGetTraining,
  portalRequestTrainingLesson,
} from "@/lib/portal-training.functions";
import { LESSON_REQUEST_REFUSALS } from "@/lib/training-portal";
import { addDaysToDay } from "@/lib/reclean";

// The client's training: each package with its balance and expiry, the
// lessons booked on it, and the lessons already taught with their scores and,
// when the business shares them, the trainer's note and homework. A client
// with a balance asks for the next lesson here; the office books it. A client
// of a business that sells packages buys one here and pays it on the existing
// pay page.
//
// English, like every other portal page: the portal speaks the business's
// language, not the reader's device (see CLAUDE.md, "What stays English").

export const Route = createFileRoute("/portal/$slug/$token/training")({
  component: PortalTraining,
});

type Training = Extract<Awaited<ReturnType<typeof portalGetTraining>>, { visible: true }>;
type Pack = Training["packages"][number];

const selectClass =
  "h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm touch:min-h-11";

const STATE_LABEL: Record<Pack["state"], string> = {
  active: "Active",
  used_up: "All sessions used",
  expired: "Expired",
  canceled: "Canceled",
};

const LESSON_STATUS: Record<string, string> = {
  completed: "Completed",
  skipped: "Canceled",
  missed: "Missed",
};

function PortalTraining() {
  const { token } = usePortalCtx();
  const getFn = useServerFn(portalGetTraining);
  const q = useQuery({
    queryKey: ["portal", token, "training"],
    queryFn: () => getFn({ data: { token } }),
    staleTime: 30_000,
  });

  if (q.isLoading)
    return <p className="p-4 text-center text-sm text-muted-foreground">Loading your training…</p>;
  if (q.error)
    return (
      <EmptyBox
        icon={<GraduationCap className="h-6 w-6 shrink-0" />}
        title="We can't load your training right now"
        body="Try again in a minute, or contact us."
      />
    );
  const data = q.data;
  if (!data || !data.visible)
    return (
      <EmptyBox
        icon={<GraduationCap className="h-6 w-6 shrink-0" />}
        title="No training on your account"
        body="Ask us if you'd like to start lessons."
      />
    );

  return (
    <div className="space-y-6" data-testid="portal-training">
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <GraduationCap className="h-4 w-4 shrink-0" /> Your training
        </h2>
        {data.packages.length === 0 ? (
          <EmptyBox
            icon={<GraduationCap className="h-6 w-6 shrink-0" />}
            title="No packages yet"
            body="Buy a package below and we'll be in touch to book your first lesson."
          />
        ) : (
          <ul className="space-y-4">
            {data.packages.map((p) => (
              <li key={p.id}>
                <PackageCard pack={p} data={data} />
              </li>
            ))}
          </ul>
        )}
      </section>
      {data.forSale.length > 0 && <BuySection data={data} />}
    </div>
  );
}

function PackageCard({ pack, data }: { pack: Pack; data: Training }) {
  const { slug, token } = usePortalCtx();
  const [asking, setAsking] = useState(false);
  const badge =
    pack.state === "active" ? (
      <Badge className="bg-emerald-600 hover:bg-emerald-600">{STATE_LABEL.active}</Badge>
    ) : (
      <Badge variant="secondary">{STATE_LABEL[pack.state]}</Badge>
    );
  return (
    <article className="space-y-4 rounded-lg border bg-card p-4 text-sm">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-base font-semibold">{pack.name}</h3>
          {pack.dogName && (
            <p className="break-words text-muted-foreground">
              For <bdi>{pack.dogName}</bdi>
            </p>
          )}
        </div>
        {badge}
      </header>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Sessions used</dt>
          <dd className="font-medium">
            {pack.sessionsUsed} of {pack.sessionsCount}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Sessions left</dt>
          <dd className="font-medium">{pack.left}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">Expires</dt>
          <dd className="font-medium">
            {pack.expiresOn ? fmtDayShort(pack.expiresOn) : "No expiry"}
          </dd>
        </div>
      </dl>

      {pack.invoice?.payable && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
          <span className="min-w-0">This package is not paid yet.</span>
          <Button asChild size="sm" className="shrink-0">
            <Link
              to="/portal/$slug/$token/pay/$invoiceId"
              params={{ slug, token, invoiceId: pack.invoice.id }}
            >
              Pay {money(pack.invoice.totalCents)}
            </Link>
          </Button>
        </div>
      )}

      <section className="space-y-2">
        <h4 className="flex items-center gap-2 font-medium">
          <CalendarClock className="h-4 w-4 shrink-0" /> Booked lessons
        </h4>
        {pack.upcoming.length === 0 && pack.requests.length === 0 ? (
          <p className="text-muted-foreground">No lessons booked.</p>
        ) : (
          <ul className="space-y-1">
            {pack.upcoming.map((l) => (
              <li key={l.id} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{fmtDayShort(l.scheduledOn)}</span>
                {l.startTime && <span dir="ltr">{l.startTime}</span>}
                {l.trainer && <span className="text-muted-foreground">with {l.trainer}</span>}
              </li>
            ))}
            {pack.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap gap-x-2 text-muted-foreground">
                <span>
                  Requested for {fmtDayShort(r.requestedOn)}
                  {r.requestedTime ? ` at ${r.requestedTime}` : ""}.
                </span>
                <span>Waiting for us to confirm.</span>
              </li>
            ))}
          </ul>
        )}
        {pack.requestBlock ? (
          pack.state === "active" || pack.requestBlock === "no_sessions_left" ? (
            <p className="text-muted-foreground">{LESSON_REQUEST_REFUSALS[pack.requestBlock]}</p>
          ) : null
        ) : asking ? (
          <LessonRequestForm pack={pack} data={data} onDone={() => setAsking(false)} />
        ) : (
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAsking(true)}>
            <CalendarPlus className="h-4 w-4 shrink-0" /> Request a lesson
          </Button>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="flex items-center gap-2 font-medium">
          <NotebookPen className="h-4 w-4 shrink-0" /> Recent lessons
        </h4>
        {pack.recent.length === 0 ? (
          <p className="text-muted-foreground">Notes from each lesson show up here afterwards.</p>
        ) : (
          <ul className="space-y-3">
            {pack.recent.map((l) => (
              <li key={l.id} className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{fmtDayShort(l.scheduledOn)}</span>
                  <span className="text-xs text-muted-foreground">
                    {LESSON_STATUS[l.status] ?? l.status}
                  </span>
                </div>
                {l.scores.length > 0 && (
                  <ul className="flex flex-wrap gap-2" aria-label="Scores">
                    {l.scores.map((s) => (
                      <li
                        key={s.skill}
                        className="max-w-full break-words rounded-full bg-muted px-2.5 py-0.5 text-xs"
                      >
                        <bdi>{s.skill}</bdi>: {s.score} of 5
                      </li>
                    ))}
                  </ul>
                )}
                {l.note && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground">Trainer's note</div>
                    <p className="whitespace-pre-line break-words">{l.note}</p>
                  </div>
                )}
                {l.homework && (
                  <div className="rounded-md bg-muted/60 p-2">
                    <div className="text-xs font-medium text-muted-foreground">
                      Homework{l.homework.dueOn ? `, by ${fmtDayShort(l.homework.dueOn)}` : ""}
                    </div>
                    <p className="whitespace-pre-line break-words">{l.homework.body}</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function LessonRequestForm({
  pack,
  data,
  onDone,
}: {
  pack: Pack;
  data: Training;
  onDone: () => void;
}) {
  const { token } = usePortalCtx();
  const qc = useQueryClient();
  const requestFn = useServerFn(portalRequestTrainingLesson);
  const first = addDaysToDay(data.today, 1);
  const farthest = addDaysToDay(data.today, 90);
  const last = pack.expiresOn && pack.expiresOn < farthest ? pack.expiresOn : farthest;
  const [day, setDay] = useState(first);
  const [time, setTime] = useState("");
  const [propertyId, setPropertyId] = useState(data.properties[0]?.id ?? "");
  const [note, setNote] = useState("");
  const send = useMutation({
    mutationFn: () =>
      requestFn({
        data: {
          token,
          clientPackageId: pack.id,
          propertyId,
          day,
          time: time || null,
          message: note.trim(),
        },
      }),
    onSuccess: (r) => {
      toast.success(
        r.alreadyAsked
          ? "You already asked for that day. We'll confirm it."
          : "Request sent. We'll confirm the lesson.",
      );
      void qc.invalidateQueries({ queryKey: ["portal", token] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!data.properties.length)
    return <p className="text-muted-foreground">Add an address on the Property tab first.</p>;
  const idBase = `lesson-${pack.id}`;
  return (
    <form
      className="space-y-3 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${idBase}-day`} className="text-xs">
            Preferred day
          </Label>
          <Input
            id={`${idBase}-day`}
            type="date"
            required
            min={first}
            max={last}
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${idBase}-time`} className="text-xs">
            Preferred time (optional)
          </Label>
          <Input
            id={`${idBase}-time`}
            type="time"
            step={900}
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>
        {data.properties.length > 1 && (
          <div className="min-w-0 space-y-1 sm:col-span-2">
            <Label htmlFor={`${idBase}-where`} className="text-xs">
              Where
            </Label>
            <select
              id={`${idBase}-where`}
              className={selectClass}
              value={propertyId}
              onChange={(e) => setPropertyId(e.target.value)}
            >
              {data.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label ? `${p.label}: ${p.street}` : p.street}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idBase}-note`} className="text-xs">
          Note for the trainer (optional)
        </Label>
        <Textarea
          id={`${idBase}-note`}
          rows={2}
          maxLength={1000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={send.isPending || !day || !propertyId}>
          {send.isPending ? "Sending…" : "Send request"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function BuySection({ data }: { data: Training }) {
  const { slug, token } = usePortalCtx();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const buyFn = useServerFn(portalBuyTrainingPackage);
  const [chosen, setChosen] = useState<string | null>(null);
  const [dogId, setDogId] = useState(data.dogs.length === 1 ? data.dogs[0].id : "");
  // One id per purchase attempt, so a double tap is one sale. A new one only
  // after a different package is chosen.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const buy = useMutation({
    mutationFn: (servicePackageId: string) =>
      buyFn({
        data: { token, servicePackageId, requestId, ...(dogId ? { dogId } : {}) },
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["portal", token] });
      void navigate({
        to: "/portal/$slug/$token/pay/$invoiceId",
        params: { slug, token, invoiceId: r.invoiceId },
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const needsDog = data.dogs.length > 1;
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <ShoppingBag className="h-4 w-4 shrink-0" /> Buy a package
      </h2>
      <ul className="space-y-2">
        {data.forSale.map((p) => {
          const open = chosen === p.id;
          return (
            <li key={p.id} className="space-y-3 rounded-lg border bg-card p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="break-words font-semibold">{p.name}</h3>
                  <p className="text-muted-foreground">
                    {p.sessionsCount} session{p.sessionsCount === 1 ? "" : "s"}
                    {p.serviceName ? `, ${p.serviceName}` : ""}
                    {p.expiresAfterDays ? `. Use within ${p.expiresAfterDays} days.` : "."}
                  </p>
                </div>
                <span className="shrink-0 font-semibold">{money(p.priceCents)}</span>
              </div>
              {open ? (
                <div className="space-y-3 rounded-md border p-3">
                  {needsDog && (
                    <div className="space-y-1">
                      <Label htmlFor={`buy-${p.id}-dog`} className="text-xs">
                        Which dog is it for?
                      </Label>
                      <select
                        id={`buy-${p.id}-dog`}
                        className={selectClass}
                        value={dogId}
                        onChange={(e) => setDogId(e.target.value)}
                      >
                        <option value="">Choose a dog</option>
                        {data.dogs.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <p className="text-muted-foreground">
                    We'll add an invoice for {money(p.priceCents)} and take you to pay it.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={buy.isPending || (needsDog && !dogId)}
                      onClick={() => buy.mutate(p.id)}
                    >
                      {buy.isPending ? "Adding…" : "Continue to payment"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setChosen(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setChosen(p.id);
                    setRequestId(crypto.randomUUID());
                  }}
                >
                  Buy this package
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
