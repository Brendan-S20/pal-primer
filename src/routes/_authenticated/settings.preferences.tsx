import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { setLanguage, currentLanguage } from "@/lib/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { isValidOrgName } from "@/lib/dna-linkage";
import { useMyRole, usePermissions } from "@/hooks/useMyRole";
import { useHeaderPrefs } from "@/hooks/useHeaderPrefs";
import { StandardPricingCard } from "@/components/StandardPricingCard";
import { reseedDemoData } from "@/lib/demo.functions";
import { isDemoOrganization } from "@/lib/demo-org";
import {
  getOrgBranding,
  updateOrgBranding,
  getMyOrg,
  setPortalSlug,
  suggestPortalSlug,
} from "@/lib/org.functions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { getDispatchSettings, updateDispatchSettings } from "@/lib/visits.functions";
import { US_TIMEZONES, DEFAULT_TIMEZONE } from "@/lib/route-window";
import { appOrigin } from "@/lib/app-origin";
import {
  getMyOrgFeatures,
  setCommercialAccounts,
  setRecleanWindowHours,
  setRequireCompletionPhoto,
} from "@/lib/org-features.functions";
import { RECLEAN_WINDOW_DEFAULT_HOURS, RECLEAN_WINDOW_MAX_HOURS } from "@/lib/reclean";
import { VisitChecklistEditor } from "@/components/VisitChecklistEditor";
import type { ChecklistItem } from "@/lib/visit-checklist";

/** One empty list, so the editor is not handed a new array on every render
 *  while the org's features load. */
const NO_CHECKLIST: ChecklistItem[] = [];

export const Route = createFileRoute("/_authenticated/settings/preferences")({
  component: PreferencesPage,
});

const HAPTICS_KEY = "scoop:haptics";
const MAP_KEY = "scoop:map-app";
const AWAKE_KEY = "scoop:keep-awake";

function getBool(key: string, def: boolean) {
  if (typeof window === "undefined") return def;
  const v = window.localStorage.getItem(key);
  return v == null ? def : v === "1";
}
function setBool(key: string, v: boolean) {
  window.localStorage.setItem(key, v ? "1" : "0");
}
function getStr(key: string, def: string) {
  if (typeof window === "undefined") return def;
  return window.localStorage.getItem(key) ?? def;
}

function PreferencesPage() {
  const { i18n, t } = useTranslation();
  const { can } = usePermissions();
  const canManageSettings = can("manage_settings");
  const [lang, setLang] = useState<string>(currentLanguage());
  const [haptics, setHaptics] = useState(true);
  const [awake, setAwake] = useState(true);
  const [mapApp, setMapApp] = useState("google");

  useEffect(() => {
    setHaptics(getBool(HAPTICS_KEY, true));
    setAwake(getBool(AWAKE_KEY, true));
    setMapApp(getStr(MAP_KEY, "google"));
  }, []);

  return (
    <div className="max-w-2xl space-y-6">
      {/* See the note in settings.deep-clean: this page also opened straight
          into a card while the other eighteen led with a heading. */}
      <div>
        <h2 className="text-lg font-semibold">Preferences</h2>
        <p className="text-sm text-muted-foreground">
          {canManageSettings
            ? "Language, branding and the defaults this workspace uses."
            : "Language and how the app behaves on your route."}
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Language</CardTitle>
          {/* It is per DEVICE (lib/i18n setLanguage writes localStorage).
              This said it applied "across the app, including the tech's My
              Day view", which an owner reads as "my techs get Spanish" and
              a tech reads as being talked about in the third person. */}
          <CardDescription>
            Changes the language on this device only. Each person picks their own.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="lang" className="text-xs">
            Interface language
          </Label>
          <Select
            value={lang}
            onValueChange={(v) => {
              setLang(v);
              setLanguage(v as "en" | "es");
              i18n.changeLanguage(v);
              toast.success(t("common.language") + " updated");
            }}
          >
            <SelectTrigger id="lang" className="mt-1 w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="es">Español</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Field tech app</CardTitle>
          <CardDescription>Behavior on route.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Haptic feedback</div>
              <div className="text-xs text-muted-foreground">
                Vibrate on start/complete/skip actions.
              </div>
            </div>
            <Switch
              checked={haptics}
              onCheckedChange={(v) => {
                setHaptics(v);
                setBool(HAPTICS_KEY, v);
              }}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Keep screen awake on route</div>
              <div className="text-xs text-muted-foreground">
                Prevents auto-lock while My Day is open.
              </div>
            </div>
            <Switch
              checked={awake}
              onCheckedChange={(v) => {
                setAwake(v);
                setBool(AWAKE_KEY, v);
              }}
            />
          </div>
          <div>
            <Label htmlFor="map" className="text-xs">
              Default map app for directions
            </Label>
            <Select
              value={mapApp}
              onValueChange={(v) => {
                setMapApp(v);
                window.localStorage.setItem(MAP_KEY, v);
              }}
            >
              <SelectTrigger id="map" className="mt-1 w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="google">Google Maps</SelectItem>
                <SelectItem value="apple">Apple Maps</SelectItem>
                <SelectItem value="waze">Waze</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <AppearanceCard />
      {/* The org's clock, and every "today" judgement in the product reads
          it. The server gates the write on manage_settings, so a tech could
          open this, pick a zone, and get an error toast: render it only for
          the people the server will listen to, like PricingBaselineCard. */}
      {canManageSettings && <TimeZoneCard />}
      <PricingBaselineCard />
      <CommercialAccountsCard />
      <CompletionPhotoCard />
      {/* Written by manage_settings only, so drawn for those roles only, like
          the time zone above: a promise to customers is not a tech's call. */}
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

/** Menus and chrome — the things about how this app LOOKS to one person.
 *
 *  ── WHY THESE MOVED HERE ─────────────────────────────────────────────────
 *
 *  The two top-bar switches lived on /profile, next to the photo, the phone
 *  number and the sign-in email. Those are facts about a PERSON. Which
 *  buttons the chrome shows is a preference, and this page is called
 *  Preferences. Owner's call, 2026-08-25, and it is the right one: nobody
 *  looking for a setting looks under their own name badge.
 *
 *  Saved per person on this device, like the switches always were — see
 *  lib/header-prefs.ts for why that is local rather than a column.
 */
function AppearanceCard() {
  const { prefs, setPref } = useHeaderPrefs();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Menus and top bar</CardTitle>
        <CardDescription>
          How this app looks to you on this device. Your other devices keep their own settings, and
          nobody else is affected.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <Label className="text-xs">Menu on a phone</Label>
          {/* ── ONE MENU, NOT TWO ────────────────────────────────────────
              The tab bar's More button and the top bar's hamburger opened two
              sheets listing the same destinations, in two corners of the same
              screen. Which of them suits you is not something the code can
              know, so it is a choice rather than a guess: a tech working
              one-handed wants the thumb-reachable bar, and somebody used to
              the desktop layout wants the menu where it has always been. */}
          <Select
            value={prefs.phoneNav}
            onValueChange={(v) => setPref("phoneNav", v as "bottom" | "side")}
          >
            <SelectTrigger className="mt-1 w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bottom">Bottom bar with More</SelectItem>
              <SelectItem value="side">Side menu</SelectItem>
            </SelectContent>
          </Select>
          <p className="pt-1.5 text-xs text-muted-foreground">
            Both menus reach every screen, so this is only about where the button is. Tablets and
            computers always use the side menu.
          </p>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Optional buttons beside the search box</Label>
          <p className="pb-1 text-xs text-muted-foreground">
            Turning one off only hides the shortcut. The Knowledge Center is still in the menu and
            the command palette, and the weather is still on the dashboard.
          </p>
          {/* The label wraps the switch so the whole row is the hit area, and
              min-h-11 makes that row legal at every width. A bare switch is a
              ~36px target with an unclickable label beside it. */}
          <label className="flex min-h-11 min-w-0 cursor-pointer items-center justify-between gap-3">
            <span className="min-w-0 flex-1 text-sm">Knowledge Center (?)</span>
            <Switch
              checked={prefs.showHelp}
              onCheckedChange={(v) => setPref("showHelp", v)}
              aria-label="Show the Knowledge Center button in the top bar"
            />
          </label>
          <label className="flex min-h-11 min-w-0 cursor-pointer items-center justify-between gap-3">
            <span className="min-w-0 flex-1 text-sm">Weather</span>
            <Switch
              checked={prefs.showWeather}
              onCheckedChange={(v) => setPref("showWeather", v)}
              aria-label="Show the weather button in the top bar"
            />
          </label>
        </div>
      </CardContent>
    </Card>
  );
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
          ? "Re-clean guarantee is off. Customers won't see the button."
          : `Customers can ask for a free re-clean within ${h} hours of a visit.`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Re-clean guarantee</CardTitle>
        <CardDescription>
          Customers can ask for a free re-clean from their portal within this many hours of a visit
          (0 turns it off). Requests land in Concerns, where you book the return visit at no charge.
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
