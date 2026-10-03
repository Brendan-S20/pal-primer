import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  listCanvassSeedClients,
  listNeighborLeads,
  addNeighborLead,
  updateNeighborLead,
  deleteNeighborLead,
  seedNeighborsForClient,
  getCanvassSignupTarget,
  type NeighborLead,
} from "@/lib/neighbors.functions";
import { SignupFlow } from "@/components/signup/SignupFlow";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import {
  MapPin,
  UserPlus,
  Trash2,
  Footprints,
  ArrowRight,
  ArrowLeft,
  Navigation2,
  Map as MapIcon,
  List,
  X,
} from "lucide-react";
import { NeighborMap, type NeighborPin } from "@/components/NeighborMap";
import { orderForWalk, splitCanvassAddress } from "@/lib/canvass-order";
import { usePermissions } from "@/hooks/useMyRole";
import { pageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/neighbors")({
  head: () => ({
    meta: [
      { title: pageTitle("Neighbor canvassing") },
      {
        name: "description",
        content: "Turn happy clients into whole-street routes with door-to-door canvassing.",
      },
    ],
  }),
  component: NeighborsPage,
});

const STATUS_LABEL: Record<NeighborLead["status"], string> = {
  new: "To visit",
  contacted: "Contacted",
  interested: "Interested",
  converted: "Signed up",
  not_interested: "Passed",
};

function NeighborsPage() {
  const listFn = useServerFn(listNeighborLeads);
  const addFn = useServerFn(addNeighborLead);
  const updateFn = useServerFn(updateNeighborLead);
  const deleteFn = useServerFn(deleteNeighborLead);
  const seedFn = useServerFn(seedNeighborsForClient);
  const clientsFn = useServerFn(listCanvassSeedClients);

  const { data, refetch, isLoading } = useQuery({
    queryKey: ["neighbor-leads"],
    queryFn: () => listFn(),
  });
  const { can } = usePermissions();
  const canSeeDirectory = can("view_client_directory");
  // Everyone who can open this page gets a picker. A directory holder is
  // offered the roster; everyone else is offered the clients on their OWN work,
  // which is the canvassing case as it actually happens — you are at the house,
  // you knock next door. Gating the whole card on view_client_directory is what
  // produced "I can't select a client to go off of for neighbors/doors" from a
  // technician standing on a street, on a page the product grants them.
  const clientsQ = useQuery({
    queryKey: ["canvass-seed-clients"],
    queryFn: () => clientsFn(),
  });
  const seedOptions = (clientsQ.data?.clients ?? []) as Array<{
    id: string;
    display_name: string;
  }>;

  const [address, setAddress] = useState("");
  // The point the address field already resolved. It used to be thrown away --
  // `onResolved` kept `formatted` and nothing else -- so every door added by
  // hand went in with no coordinate, could never appear on the map, and had no
  // place in a walk order. The geocoder had already answered; nobody wrote it
  // down.
  const [addressPoint, setAddressPoint] = useState<{ lat: number; lon: number } | null>(null);
  const [notes, setNotes] = useState("");
  const [seedClient, setSeedClient] = useState<string>("");
  const [seedCount, setSeedCount] = useState(6);
  // Phone-only collapse; see the note above the two cards.
  const [showAddForms, setShowAddForms] = useState(false);

  const add = useMutation({
    mutationFn: () =>
      addFn({
        data: {
          addressLine: address,
          notes: notes || undefined,
          latitude: addressPoint?.lat ?? null,
          longitude: addressPoint?.lon ?? null,
        },
      }),
    onSuccess: () => {
      toast.success("Lead added");
      setAddress("");
      setAddressPoint(null);
      setNotes("");
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const seed = useMutation({
    mutationFn: () => seedFn({ data: { clientId: seedClient, count: seedCount } }),
    onSuccess: (r) => {
      const aside = [
        r.duplicates ? `${r.duplicates} already on the list` : null,
        r.unresolved
          ? `${r.unresolved} address${r.unresolved === 1 ? "" : "es"} didn't exist`
          : null,
      ].filter(Boolean);
      const line = `Seeded ${r.added} neighbor door${r.added === 1 ? "" : "s"}`;
      if (r.added === 0) toast.message(line, { description: aside.join(" · ") || undefined });
      else toast.success(line, { description: aside.join(" · ") || undefined });
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: (v: { id: string; status?: NeighborLead["status"]; notes?: string | null }) =>
      updateFn({ data: v }),
    onSuccess: () => refetch(),
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => refetch(),
  });

  const rows = data?.rows ?? [];
  const s = data?.summary ?? { total: 0 };
  // Zero doors is a different PAGE, not a smaller number. Measured at 375px on
  // 2026-09-19 against an org with no canvassing rows: five stacked tiles all
  // reading 0 filled the entire first screen, the two ways of actually getting
  // a door were below the fold, and the pitch was squeezed into a narrow
  // column beside a disabled "Walk mode (0)" button. A funnel of zeros tells a
  // first-time user nothing except that they have not started; the two entry
  // cards are the only controls on the page that can change that, so at zero
  // they ARE the page.
  //
  // Gated on `!isLoading` and not on the count alone, because during the
  // initial fetch `rows` is [] for a workspace with three hundred doors too —
  // ungated, every visit would flash the first-run pitch and then swap it for
  // the funnel, which reads as the leads briefly going missing.
  const firstRun = !isLoading && rows.length === 0;
  const [walkMode, setWalkMode] = useState(false);
  const [view, setView] = useState<"list" | "map">("list");

  const [walkIdx, setWalkIdx] = useState(0);
  // Doors answered during THIS walk. The queue used to be recomputed straight
  // from server state and the index bumped by one after every button, so the
  // three buttons that take a door OUT of the queue -- interested, passed,
  // signed up -- shifted everything down by one and then skipped past it. A
  // tech pressing "Interested" missed the next house, every time. Holding the
  // answered ids locally makes the queue update immediately instead of a
  // refetch later, and removes the index arithmetic that caused it.
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const walkQueue = orderForWalk(
    rows.filter((r) => (r.status === "new" || r.status === "contacted") && !answered.has(r.id)),
  );
  const current = walkQueue[Math.min(walkIdx, Math.max(walkQueue.length - 1, 0))];
  // Answering a door removes it from the queue, so the next one slides into
  // this position and the index must NOT move. Skip is the only thing that
  // advances past a door still waiting for an answer.
  const answer = (status: NeighborLead["status"]) => {
    if (!current) return;
    update.mutate({ id: current.id, status });
    setAnswered((prev) => new Set(prev).add(current.id));
  };

  // ── Sign them up at the door ─────────────────────────────────────────────
  //
  // "Signed up" used to flip the lead's status and nothing else — a record of
  // a signup that had no way to happen. The sheet runs the org's REAL signup
  // flow (the same quote / details / card machine as /signup/{slug}, see
  // SignupFlow.tsx) prefilled from the door, so the tech hands the phone over
  // and the prospect is a provisioned customer before the tech reaches the
  // next house. The status flip survives as the fallback inside the sheet,
  // because paper signups and "text me the link" are real outcomes too.
  const targetFn = useServerFn(getCanvassSignupTarget);
  const targetQ = useQuery({
    queryKey: ["canvass-signup-target"],
    queryFn: () => targetFn(),
    staleTime: 300_000,
  });
  const [signupDoor, setSignupDoor] = useState<NeighborLead | null>(null);
  const convertDoor = (door: NeighborLead) => {
    update.mutate({ id: door.id, status: "converted" });
    setAnswered((prev) => new Set(prev).add(door.id));
    setSignupDoor(null);
  };

  if (walkMode) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight md:text-xl md:font-semibold">
            <Footprints className="h-6 w-6 shrink-0" /> Walk mode
          </h1>
          <Button variant="outline" size="sm" onClick={() => setWalkMode(false)}>
            Exit
          </Button>
        </div>
        {!current ? (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground">
              No more doors in the queue. Great work!
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="space-y-4 p-6">
              <div className="text-xs text-muted-foreground">
                Door {walkIdx + 1} of {walkQueue.length}
              </div>
              <div className="text-xl font-semibold">{current.address_line}</div>
              {current.seed_client_name && (
                <div className="text-sm text-muted-foreground">
                  Seeded from: {current.seed_client_name}
                </div>
              )}
              {current.notes && <p className="rounded bg-muted p-2 text-sm">{current.notes}</p>}
              <a
                className="inline-flex items-center gap-1 text-sm text-primary underline"
                href={`https://maps.google.com/?q=${encodeURIComponent(current.address_line)}`}
                target="_blank"
                rel="noreferrer"
              >
                <Navigation2 className="h-4 w-4 shrink-0" /> Navigate
              </a>
              <div className="grid grid-cols-2 gap-2 pt-2">
                <Button variant="secondary" onClick={() => answer("contacted")}>
                  Left flyer
                </Button>
                <Button onClick={() => answer("interested")}>Interested</Button>
                <Button variant="destructive" onClick={() => answer("not_interested")}>
                  Passed
                </Button>
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700"
                  onClick={() => setSignupDoor(current)}
                >
                  Sign up
                </Button>
              </div>
              <div className="flex items-center justify-between pt-2 text-xs">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={walkIdx === 0}
                  onClick={() => setWalkIdx((i) => Math.max(0, i - 1))}
                >
                  <ArrowLeft className="mr-1 h-4 w-4 shrink-0" /> Prev
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={walkIdx >= walkQueue.length - 1}
                  onClick={() => setWalkIdx((i) => Math.min(i + 1, walkQueue.length - 1))}
                >
                  Skip <ArrowRight className="ml-1 h-4 w-4 shrink-0" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* The signup sheet. Bottom sheet, because walk mode is a phone in a
            driveway: the door's card stays visible above it and closing it
            lands back mid-walk with nothing lost. */}
        <Sheet open={!!signupDoor} onOpenChange={(open) => !open && setSignupDoor(null)}>
          <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto">
            <SheetHeader className="text-left">
              <SheetTitle>Sign up {signupDoor?.address_line}</SheetTitle>
            </SheetHeader>
            {!signupDoor ? null : targetQ.isLoading ? (
              <p className="py-6 text-sm text-muted-foreground">Loading your signup page…</p>
            ) : targetQ.data?.enabled && targetQ.data.effectiveSlug ? (
              <div className="space-y-4 pt-4">
                <SignupFlow
                  slug={targetQ.data.effectiveSlug}
                  variant="sheet"
                  prefill={splitCanvassAddress(signupDoor.address_line)}
                  onPaid={() => {
                    toast.success("Signed up and paid", {
                      description: "Their account is being set up; they'll get a welcome email.",
                    });
                    convertDoor(signupDoor);
                  }}
                />
                <Button
                  variant="ghost"
                  className="w-full"
                  onClick={() => convertDoor(signupDoor)}
                >
                  They signed up another way, just mark the door
                </Button>
              </div>
            ) : (
              <div className="space-y-4 pt-4">
                <p className="text-sm text-muted-foreground">
                  Online signup is turned off for your company, so there is nothing to hand the
                  phone over to. An owner can turn it on under Settings, or you can mark the door
                  and the office will finish the signup.
                </p>
                <Button className="w-full" onClick={() => convertDoor(signupDoor)}>
                  Mark signed up, office will finish it
                </Button>
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  // The two ways a door gets onto the list, built once and PLACED by the
  // branch below. First run and the working page offer the same two actions —
  // the difference is placement, not function: at zero doors these cards are
  // the whole page, and once a list exists they are an office chore that folds
  // away on phones. Two copies of this JSX is how the first-run seed form and
  // the everyday seed form drift apart.
  const seedCard = seedOptions.length > 0 && (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Seed from an existing client</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label>Client</Label>
          <select
            value={seedClient}
            onChange={(e) => setSeedClient(e.target.value)}
            className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm"
          >
            <option value="">Pick a client…</option>
            {seedOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>How many doors</Label>
          <Input
            type="number"
            min={1}
            max={20}
            value={seedCount}
            onChange={(e) => setSeedCount(Number(e.target.value))}
          />
        </div>
        <Button disabled={!seedClient || seed.isPending} onClick={() => seed.mutate()}>
          <UserPlus className="mr-1.5 h-4 w-4 shrink-0" />
          {seed.isPending ? "Seeding…" : `Seed ${seedCount} neighbors`}
        </Button>
        <p className="text-xs text-muted-foreground">
          Works out the house numbers either side of this client, checks each one against address
          search, and adds the ones that turned out to be real. Doors already on your list, and your
          own clients, are left out.
        </p>
      </CardContent>
    </Card>
  );

  const manualCard = (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a door manually</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label>Address</Label>
          {/* The single best-biased field in the app: a canvassing door is
                  by definition on a street the workspace already services, and
                  the proxy biases suggestions to the average of the org's
                  geocoded properties. Stored as one line (`address_line`), so
                  a match writes the formatted address. */}
          <AddressAutocomplete
            value={address}
            onChangeText={(v) => {
              setAddress(v);
              // Typing past a resolved match makes the point stale, and a
              // stale point is exactly the fault this page had: text and
              // coordinate describing different places.
              setAddressPoint(null);
            }}
            onResolved={(r) => {
              setAddress(r.address.formatted);
              setAddressPoint(
                r.address.latitude != null && r.address.longitude != null
                  ? { lat: r.address.latitude, lon: r.address.longitude }
                  : null,
              );
            }}
            placeholder="123 Elm St, Springfield"
          />
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Saw a golden retriever in the yard"
          />
        </div>
        <Button disabled={address.trim().length < 3 || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? "Adding…" : "Add lead"}
        </Button>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      {/* `flex-col` below sm, a row above. The description used to share one
          row with the Walk mode button at every width, and at 375px that
          wrapped it into a column about half the screen wide next to a button
          it could not use. Stacking is a WIDTH decision (where things go), not
          an input one, so `sm:` is the right variant here — contrast the
          touch-target sizing rules, which are spelled `touch:`. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight md:text-xl md:font-semibold">
            <MapPin className="h-6 w-6 shrink-0" /> Neighbor canvassing
          </h1>
          <p className="text-sm text-muted-foreground">
            Every new client is a beachhead. Seed 5-10 doors on their street, canvass them, and turn
            one house into a whole route.
          </p>
        </div>
        {/* Hidden at first run rather than shown disabled. A disabled
            "Walk mode (0)" on a page with no doors advertises a mode that
            cannot start and answers a question nobody asked yet; it was also
            the thing squeezing the pitch at phone widths. It reappears with
            the first door — any new door has status "new", which is in the
            walk queue. Once doors EXIST it stays visible even when the queue
            is empty (every door answered): at that point Walk mode is a place
            the user has been, and a control that vanishes reads as a lost
            feature, so disabled-with-a-(0) is the honest state. Hidden while
            loading too, because until the count arrives we do not know which
            of those two pages this is, and a button that flashes in disabled
            and then vanishes is worse than one that arrives once. */}
        {!isLoading && !firstRun && (
          <Button
            variant="outline"
            className="shrink-0 self-start"
            onClick={() => {
              setWalkIdx(0);
              setAnswered(new Set());
              setWalkMode(true);
            }}
            disabled={walkQueue.length === 0}
          >
            <Footprints className="mr-1.5 h-4 w-4 shrink-0" />
            Walk mode ({walkQueue.length})
          </Button>
        )}
      </div>

      {isLoading ? (
        // Loading is its own render, not a zero. Without this branch the page
        // either flashes five zero tiles at everyone (the old behaviour) or,
        // gated only on the count, flashes the first-run pitch at a workspace
        // with hundreds of doors. `useQuery`'s `isLoading` is true only for
        // the initial fetch, so refetches after a mutation stay on whichever
        // page is already up instead of bouncing through this card.
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">Loading…</CardContent>
        </Card>
      ) : firstRun ? (
        // ── First run: the pitch and the two ways in, nothing else. ────────
        // No funnel (five zeros is not information), no collapse toggle (there
        // is no list to bury the forms under), no canvassing-list card (a
        // five-column table holding one sentence). The entry cards are the
        // page, which puts "Seed from an existing client" on the first screen
        // of a 360px phone instead of below a screenful of tiles.
        <>
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            No doors on the list yet. Start below: the funnel and Walk mode appear with the first
            door.
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {seedCard}
            {manualCard}
          </div>
        </>
      ) : (
        <>
          {/* Two-up on phones rather than five stacked: five full-width tiles
              is a whole 360px screen of numbers before the first control. The
              odd fifth tile takes its own row, which is fine — "Signed up" is
              the number the funnel exists to grow. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Total" value={s.total} />
            <Stat label="To visit" value={s.new ?? 0} />
            <Stat label="Contacted" value={s.contacted ?? 0} />
            <Stat label="Interested" value={s.interested ?? 0} />
            <Stat label="Signed up" value={s.converted ?? 0} tone="good" />
          </div>

          {/* Two data-entry cards used to sit permanently between the stats
              and the canvassing list. Side by side on a laptop that costs
              nothing, but they are `md:grid-cols-2`, so on a phone they stack
              into roughly a screen and a half of form that a tech standing on
              a street has to scroll past to reach the door list — which is the
              only reason they opened this page. Seeding and adding doors are
              office actions; walking the list is the field one.

              Collapsed on phones only, rather than everywhere: on a laptop
              there is room for all three and hiding them would cost the office
              a click for no gain. So the toggle is `md:hidden` and the
              container drops `max-md:hidden` — CSS rather than a media-query
              hook, which keeps the server and client renders identical.
              `waste-log.tsx` collapses its own form the same way (D polish). */}
          <div className="flex items-center justify-between md:hidden">
            <h2 className="text-sm font-medium">Add doors</h2>
            <Button
              size="sm"
              variant={showAddForms ? "ghost" : "outline"}
              onClick={() => setShowAddForms((v) => !v)}
              // The visible word is "Add" because the heading beside it already
              // says what; a screen reader hears the button alone, so its name
              // carries the whole action.
              aria-label={showAddForms ? "Close add doors" : "Add doors"}
              aria-expanded={showAddForms}
            >
              {showAddForms ? (
                <>
                  <X className="mr-1.5 h-4 w-4 shrink-0" /> Close
                </>
              ) : (
                <>
                  <UserPlus className="mr-1.5 h-4 w-4 shrink-0" /> Add
                </>
              )}
            </Button>
          </div>

          <div className={`grid gap-4 md:grid-cols-2 ${showAddForms ? "" : "max-md:hidden"}`}>
            {seedCard}
            {manualCard}
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Canvassing list</CardTitle>
              <div className="flex gap-1 rounded-md border p-0.5">
                <Button
                  size="sm"
                  variant={view === "list" ? "secondary" : "ghost"}
                  className="h-7 px-2"
                  onClick={() => setView("list")}
                >
                  <List className="mr-1 h-3.5 w-3.5 shrink-0" /> List
                </Button>
                <Button
                  size="sm"
                  variant={view === "map" ? "secondary" : "ghost"}
                  className="h-7 px-2"
                  onClick={() => setView("map")}
                >
                  <MapIcon className="mr-1 h-3.5 w-3.5 shrink-0" /> Map
                </Button>
              </div>
            </CardHeader>
            {/* Five columns of canvassing results, previously sizing the page
            rather than themselves. */}
            <CardContent className="overflow-x-auto p-0">
              {view === "map" ? (
                <CanvassMap rows={rows} />
              ) : (
                <table className="w-full text-sm min-w-[480px]">
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Address</th>
                      <th className="px-3 py-2">Seed client</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Notes</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                          Loading…
                        </td>
                      </tr>
                    ) : rows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                          No leads yet. Seed from a happy client to get going.
                        </td>
                      </tr>
                    ) : (
                      rows.map((r) => (
                        <tr key={r.id} className="border-t align-top">
                          <td className="px-3 py-2 font-medium">{r.address_line}</td>
                          <td className="px-3 py-2 text-muted-foreground text-xs">
                            {r.seed_client_name ?? "-"}
                          </td>
                          <td className="px-3 py-2">
                            <select
                              value={r.status}
                              onChange={(e) =>
                                update.mutate({ id: r.id, status: e.target.value as any })
                              }
                              className="rounded border bg-background px-2 py-1 text-xs"
                            >
                              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                                <option key={k} value={k}>
                                  {v}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2 max-w-[300px] text-xs text-muted-foreground">
                            {r.notes ?? "-"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <ConfirmButton
                              trigger={
                                <Button size="sm" variant="ghost">
                                  <Trash2 className="h-4 w-4 shrink-0" />
                                </Button>
                              }
                              title="Delete this entry?"
                              description="This removes the canvassing entry permanently and can't be undone."
                              confirmLabel="Delete"
                              onConfirm={() => del.mutate(r.id)}
                            />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/** The map half of the canvassing card.
 *
 *  Its own component for two reasons. It grew a filter, an empty state and a
 *  count of what it cannot show, and inline that pushed the sibling `<table>`
 *  34 lines below the `overflow-x-auto` on CardContent -- past the 25-line
 *  lookback in tests/wide-things-that-set-the-width-of-the-page.test.ts, which
 *  correctly reported a five-column table with no scroll container. The rule
 *  is right and the distance was the problem.
 *
 *  And a door with no coordinate is now an ordinary state rather than an
 *  impossible one: seeding stopped inventing points, so a workspace with no
 *  address search has doors that are real, listable, walkable and unmappable.
 *  Drawing fewer pins than the list has rows, silently, is how somebody
 *  concludes the leads went missing. */
function CanvassMap({ rows }: { rows: NeighborLead[] }) {
  const placed = rows.filter((r) => r.latitude != null && r.longitude != null);
  const unplaced = rows.length - placed.length;
  return (
    <div className="p-3">
      {placed.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          None of these doors has a location yet. Add one with address search, or seed from a
          client, and the pins appear here.
        </div>
      ) : (
        <>
          {unplaced > 0 && (
            <p className="mb-2 text-xs text-muted-foreground">
              {unplaced} of {rows.length} doors have no location and are not on this map. They are
              still in the list and in Walk mode.
            </p>
          )}
          <NeighborMap
            pins={placed.map<NeighborPin>((r) => ({
              id: r.id,
              address: r.address_line,
              status: r.status,
              latitude: r.latitude,
              longitude: r.longitude,
              seedClientName: r.seed_client_name,
              isSeed: false,
            }))}
          />
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "good" }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold ${tone === "good" ? "text-emerald-600" : ""}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
