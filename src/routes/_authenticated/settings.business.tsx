import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useMyRole, usePermissions } from "@/hooks/useMyRole";
import { StandardPricingCard } from "@/components/StandardPricingCard";
import { reseedDemoData } from "@/lib/demo.functions";
import { isDemoOrganization } from "@/lib/demo-org";
import { getMyOrg } from "@/lib/org.functions";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { getDispatchSettings, updateDispatchSettings } from "@/lib/visits.functions";
import { US_TIMEZONES, DEFAULT_TIMEZONE } from "@/lib/route-window";
import {
  getMyOrgFeatures,
  setCommercialAccounts,
  setRecleanWindowHours,
  setRequireCompletionPhoto,
} from "@/lib/org-features.functions";
import { RECLEAN_WINDOW_DEFAULT_HOURS, RECLEAN_WINDOW_MAX_HOURS } from "@/lib/reclean";
import { VisitChecklistEditor } from "@/components/VisitChecklistEditor";
import type { ChecklistItem } from "@/lib/visit-checklist";
import { titleHead } from "@/lib/page-title";

// ── WHAT THE WHOLE BUSINESS USES, NOT WHAT THIS PHONE DOES ───────────────
//
// These cards were on Settings → Preferences, beside language, haptics and
// the phone menu. Those four are per DEVICE: they live in this browser's
// storage and change nothing for anyone else. Everything here is per
// BUSINESS: the time zone that defines "today" for every screen and the
// portal, the standard price new clients are quoted, whether HOAs are served,
// the completion-photo and checklist rule every tech is held to, and the
// re-clean promise made to clients. Changing one changes it for everybody.
//
// One page holding both meant an owner could not tell which switch was which
// kind, and a technician opened Preferences to change their language and
// scrolled past cards about the business (launch pass, 2026-10,
// recommendation 4). Preferences now holds only the device; this page holds
// the business, and the settings rail never offers it to a technician.
//
// The cards are moved, not rewritten: each keeps its own permission check, so
// a dispatcher-shaped role that can read but not write still sees the
// read-only state it saw before.

/** One empty list, so the editor is not handed a new array on every render
 *  while the org's features load. */
const NO_CHECKLIST: ChecklistItem[] = [];

export const Route = createFileRoute("/_authenticated/settings/business")({
  head: () => titleHead("Business defaults", "Settings"),
  component: BusinessDefaultsPage,
});

function BusinessDefaultsPage() {
  const { can } = usePermissions();
  const canManageSettings = can("manage_settings");
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Business defaults</h2>
        <p className="text-sm text-muted-foreground">
          Rules and defaults the whole business uses. A change here applies to everyone on the team
          and to what your clients see. Settings that only affect this device are under Preferences.
        </p>
      </div>
      {/* The org's clock, and every "today" judgement in the product reads
          it. The server gates the write on manage_settings, so render it only
          for the people the server will listen to, like PricingBaselineCard. */}
      {canManageSettings && <TimeZoneCard />}
      <PricingBaselineCard />
      <CommercialAccountsCard />
      <CompletionPhotoCard />
      {/* Written by manage_settings only, so drawn for those roles only, like
          the time zone above: a promise to clients is not a tech's call. */}
      {canManageSettings && <RecleanGuaranteeCard />}
      <DemoDataCard />
    </div>
  );
}

// Standard pricing moved here from the top of the Zones page (QA round 3,
// C5): it is workspace-wide configuration, not a zone.
// IMP-8: the org time zone lived only in the Routes dispatch panel, where its
// help text framed it as a routing detail. It is not — it is the definition of
// "today" for the whole product: the portal's next-visit window (BUG-12), the
// nightly missed-visit job, the end-of-day close-out prompt (BUILD-11), and
// route windows all resolve dates against it. Settings is where someone looks
// for that, so it lives here now and Routes points at it.
//
// Same server fn and the same US_TIMEZONES list the Routes panel used — moved,
// not reimplemented, so there is one control and one source of options (10.2).
function TimeZoneCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getDispatchSettings);
  const updateFn = useServerFn(updateDispatchSettings);
  const q = useQuery({ queryKey: ["dispatch-settings"], queryFn: () => getFn() });
  const current = (q.data?.settings as { timezone?: string | null } | undefined)?.timezone;

  const m = useMutation({
    mutationFn: (timezone: string) => updateFn({ data: { timezone } }),
    onSuccess: () => {
      toast.success("Time zone saved");
      qc.invalidateQueries({ queryKey: ["dispatch-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Time zone</CardTitle>
        <CardDescription>
          Your business's local time. This decides what counts as "today" everywhere: the schedule,
          your clients' portal, overdue and missed-visit detection, and arrival windows.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Label htmlFor="org-timezone" className="text-xs">
          Time zone
        </Label>
        <select
          id="org-timezone"
          value={current ?? DEFAULT_TIMEZONE}
          disabled={q.isLoading || m.isPending}
          onChange={(e) => m.mutate(e.target.value)}
          className="mt-1 h-10 w-full max-w-sm rounded-md border bg-background px-3 text-sm disabled:opacity-60"
        >
          {US_TIMEZONES.map((tz) => (
            <option key={tz.value} value={tz.value}>
              {tz.label}
            </option>
          ))}
        </select>
      </CardContent>
    </Card>
  );
}

function PricingBaselineCard() {
  const { can } = usePermissions();
  if (!can("manage_pricing")) return null;
  return <StandardPricingCard />;
}

function DemoDataCard() {
  const { role } = useMyRole();
  const orgFn = useServerFn(getMyOrg);
  const orgQ = useQuery({ queryKey: ["my-org"], queryFn: () => orgFn(), staleTime: 60_000 });
  const { confirm, dialog } = useConfirmDialog();
  const reseedFn = useServerFn(reseedDemoData);
  const mut = useMutation({
    mutationFn: () => reseedFn({ data: {} }),
    onSuccess: (r) => {
      toast.success(
        `Demo reset: ${r.clients} clients, ${r.visits_created} visits, ${r.invoices_created} invoices`,
      );
      setTimeout(() => window.location.reload(), 1500);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Every business used to see a red "wipes your organization" card here, and
  // the server refuses it for all but demo accounts. Same rule, both ends.
  if (role !== "owner" || !isDemoOrganization(orgQ.data?.organization as any)) return null;

  return (
    <Card className="border-destructive/30">
      {dialog}
      <CardHeader>
        <CardTitle>Demo data</CardTitle>
        <CardDescription>
          Wipes your organization's demo rows and rebuilds a rich fixture: 6 clients (residential +
          HOA), zones, sketched yards, subscriptions, 8 weeks of visits (including weather
          reschedules and skips), invoices in multiple states, promo codes, a gift card, referrals,
          and QC tickets. Safe to run repeatedly.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="destructive"
          disabled={mut.isPending}
          onClick={async () => {
            if (
              await confirm({
                title: "Reseed demo data?",
                description: "This wipes and rebuilds the demo data for this organization.",
                destructive: true,
                confirmLabel: "Reseed demo data",
              })
            )
              mut.mutate();
          }}
        >
          {mut.isPending ? "Reseeding…" : "Reseed demo data"}
        </Button>
      </CardContent>
    </Card>
  );
}

function CompletionPhotoCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getMyOrgFeatures);
  const setFn = useServerFn(setRequireCompletionPhoto);
  const { can, role } = usePermissions();
  const canEdit = can("manage_settings");
  const q = useQuery({ queryKey: ["my-org-features"], queryFn: () => getFn() });
  const mut = useMutation({
    mutationFn: (required: boolean) => setFn({ data: { required } }),
    onSuccess: (_r, required) => {
      qc.invalidateQueries({ queryKey: ["my-org-features"] });
      // My Day reads the rule from the shell's org query.
      qc.invalidateQueries({ queryKey: ["my-org"] });
      toast.success(
        required
          ? "Techs need a completion photo, or a reason there isn't one."
          : "A completion photo is now optional.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (role === "tech") return null;
  const on = q.data?.requireCompletionPhoto ?? true;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Finishing a visit</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="require-completion-photo" className="text-sm font-medium">
              Require a completion photo
            </Label>
            <div className="mt-0.5 text-xs text-muted-foreground">
              On: a photo before completing, or the tech&apos;s reason there isn&apos;t one. Off:
              optional.
            </div>
          </div>
          <Switch
            id="require-completion-photo"
            checked={on}
            disabled={!canEdit || mut.isPending || q.isLoading}
            onCheckedChange={(v) => mut.mutate(v)}
          />
        </div>
        <div className="mt-3">
          <VisitChecklistEditor
            saved={q.data?.visitChecklist ?? NO_CHECKLIST}
            emailOn={q.data?.emailVisitChecklist ?? false}
            canEdit={canEdit}
            loading={q.isLoading}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The re-clean guarantee: how long after a visit a customer can ask, from
 * their portal, for a free return visit.
 *
 * A number rather than a switch because the promise businesses actually make
 * varies — "24-hour re-clean guarantee" is the common one, 48 and 72 are not
 * rare — and 0 is the off position, which is one control instead of a switch
 * plus a number that means nothing while the switch is off. The database
 * caps it at a week (168); past that it is a second visit, not a re-clean.
 */
function RecleanGuaranteeCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getMyOrgFeatures);
  const setFn = useServerFn(setRecleanWindowHours);
  const q = useQuery({ queryKey: ["my-org-features"], queryFn: () => getFn() });
  const saved = q.data?.recleanWindowHours ?? RECLEAN_WINDOW_DEFAULT_HOURS;
  const [draft, setDraft] = useState<string>("");
  useEffect(() => {
    if (q.data) setDraft(String(q.data.recleanWindowHours ?? RECLEAN_WINDOW_DEFAULT_HOURS));
  }, [q.data]);

  const hours = Number(draft);
  const valid =
    draft.trim() !== "" &&
    Number.isInteger(hours) &&
    hours >= 0 &&
    hours <= RECLEAN_WINDOW_MAX_HOURS;

  const mut = useMutation({
    mutationFn: (h: number) => setFn({ data: { hours: h } }),
    onSuccess: (_r, h) => {
      qc.invalidateQueries({ queryKey: ["my-org-features"] });
      toast.success(
        h === 0
          ? "Re-clean guarantee is off. Clients won't see the button."
          : `Clients can ask for a free re-clean within ${h} hours of a visit.`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Re-clean guarantee</CardTitle>
        <CardDescription>
          Clients can ask for a free re-clean from their portal within this many hours of a visit (0
          turns it off). Requests land in Concerns, where you book the return visit at no charge.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Label htmlFor="reclean-window" className="text-xs">
          Hours after a visit
        </Label>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Input
            id="reclean-window"
            type="number"
            inputMode="numeric"
            min={0}
            max={RECLEAN_WINDOW_MAX_HOURS}
            step={1}
            className="w-28"
            value={draft}
            disabled={q.isLoading || mut.isPending}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button
            disabled={!valid || hours === saved || mut.isPending || q.isLoading}
            onClick={() => mut.mutate(hours)}
          >
            {mut.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        {!valid && draft.trim() !== "" && (
          <p className="mt-1.5 text-xs text-destructive">
            A whole number from 0 to {RECLEAN_WINDOW_MAX_HOURS} (a week).
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Does this business serve HOAs, apartment complexes and dog parks?
 *
 * It reads like a preference and it is not one: switching it off removes the
 * DNA compliance workspace from the sidebar and the client-type picker from
 * every client form. So the copy says what disappears, rather than asking an
 * abstract question and letting the owner discover the consequences.
 *
 * Turning it OFF is refused by the server while commercial clients,
 * properties, stations or DNA enrolment exist — hiding those screens would
 * strand a customer's unit charges, station service proof and violation
 * fines. The switch pre-empts that refusal so the owner reads an explanation
 * instead of an error toast.
 */
function CommercialAccountsCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getMyOrgFeatures);
  const setFn = useServerFn(setCommercialAccounts);
  const { role } = useMyRole();
  const canEdit = role === "owner" || role === "office_manager";
  const q = useQuery({ queryKey: ["my-org-features"], queryFn: () => getFn() });

  const mut = useMutation({
    mutationFn: (enabled: boolean) => setFn({ data: { enabled } }),
    onSuccess: (_r, enabled) => {
      // Invalidate rather than set: the sidebar reads the same query key, and
      // it should redraw from the server's answer, not from what we asked for.
      qc.invalidateQueries({ queryKey: ["my-org-features"] });
      toast.success(
        enabled
          ? "Commercial accounts are on. HOA and apartment tools are back in the sidebar."
          : "Commercial accounts are off. Your screens now only mention homes.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // A business-shape switch the tech can neither use nor act on: it rendered
  // for them as a greyed toggle about "we serve HOAs". Office roles that
  // cannot edit (a dispatcher) still see it read-only, which tells them why
  // the unit tools are or are not in their sidebar. After the hooks above,
  // which must run in the same order on every render.
  if (role === "tech") return null;

  const on = !!q.data?.commercialAccounts;
  const locked = on && !!q.data?.hasCommercialData;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Commercial accounts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium">
              We serve HOAs, apartment complexes or dog parks
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Off: every screen talks about homes and dogs, and the DNA compliance workspace and
              client-type picker are hidden. On: you also get unit rosters, waste stations and
              per-unit pricing.
            </div>
          </div>
          <Switch
            checked={on}
            disabled={!canEdit || locked || mut.isPending || q.isLoading}
            onCheckedChange={(v) => mut.mutate(v)}
          />
        </div>
        {locked && (
          <p className="text-xs text-muted-foreground">
            This can&apos;t be switched off while you have commercial clients, properties or waste
            stations on the books. Their units, service records and any DNA fines live on the
            screens it would hide. Move them to residential first if you no longer serve them.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
