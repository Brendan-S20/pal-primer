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
import { useMyRole, usePermissions } from "@/hooks/useMyRole";
import { useHeaderPrefs } from "@/hooks/useHeaderPrefs";
import { StandardPricingCard } from "@/components/StandardPricingCard";
import { reseedDemoData } from "@/lib/demo.functions";
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
import { getMyOrgFeatures, setCommercialAccounts } from "@/lib/org-features.functions";

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
          Language, branding and the defaults this workspace uses.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Language</CardTitle>
          <CardDescription>
            Applies across the app, including the tech's My Day view.
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
      <TimeZoneCard />
      <PricingBaselineCard />
      <PortalAddressCard />
      <BrandingCard />
      <CommercialAccountsCard />
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

function PortalAddressCard() {
  const qc = useQueryClient();
  const orgFn = useServerFn(getMyOrg);
  const setFn = useServerFn(setPortalSlug);
  const suggestFn = useServerFn(suggestPortalSlug);
  const { role } = useMyRole();
  const canEdit = role === "owner" || role === "office_manager";

  const q = useQuery({ queryKey: ["my-org"], queryFn: () => orgFn(), staleTime: 60_000 });
  const currentSlug = (q.data?.organization as any)?.portal_slug as string | undefined;
  const [slug, setSlug] = useState("");
  useEffect(() => {
    if (currentSlug) setSlug(currentSlug);
  }, [currentSlug]);

  const mut = useMutation({
    mutationFn: () => setFn({ data: { slug } }),
    onSuccess: (r) => {
      setSlug(r.slug);
      toast.success("Portal address saved");
      qc.invalidateQueries({ queryKey: ["my-org"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const suggestMut = useMutation({
    mutationFn: () => suggestFn(),
    onSuccess: (r) => setSlug(r.slug),
  });

  if (!canEdit) return null;
  // THE ONE THE OWNER SAW. This card shows the company's permanent portal
  // address, to be put on a website and read to customers — and it rendered
  // `capacitor://localhost/portal/` in the iOS app.
  //
  // The ternary is backwards for the native build in exactly the way
  // onboarding.tsx was: it prefers the page origin whenever a browser exists,
  // and inside the binary a browser DOES exist with an origin no customer can
  // open. The fallback was already the right answer for every platform.
  const base = appOrigin();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Portal sign-in address</CardTitle>
        <CardDescription>
          Your company's permanent portal link. Put it on your website so clients can sign in
          anytime. They'll enter their phone or email and get a one-time code.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <span className="text-muted-foreground">{base.replace(/^https?:\/\//, "")}/portal/</span>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
            className="h-8 w-48"
            placeholder="your-company"
          />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={mut.isPending || !slug || slug === currentSlug}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "Saving…" : "Save address"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={suggestMut.isPending}
            onClick={() => suggestMut.mutate()}
          >
            Suggest from name
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Letters, numbers, and hyphens only. Existing client links keep working automatically.
        </p>
      </CardContent>
    </Card>
  );
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

function BrandingCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getOrgBranding);
  const setFn = useServerFn(updateOrgBranding);
  const q = useQuery({ queryKey: ["org-branding"], queryFn: () => getFn() });
  const { role } = useMyRole();
  const canEdit = role === "owner" || role === "office_manager";

  const [brandColor, setBrandColor] = useState("#16a34a");
  const [logoUrl, setLogoUrl] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactAddress, setContactAddress] = useState("");
  const [cutoff, setCutoff] = useState(18);
  const [allowResched, setAllowResched] = useState(true);
  const [allowHold, setAllowHold] = useState(true);
  const [allowFreq, setAllowFreq] = useState(true);
  const [autoApply, setAutoApply] = useState(false);

  useEffect(() => {
    if (!q.data) return;
    setBrandColor(q.data.brand_color ?? "#16a34a");
    setLogoUrl(q.data.logo_url ?? "");
    setContactPhone(q.data.contact_phone ?? "");
    setContactEmail(q.data.contact_email ?? "");
    setContactAddress(q.data.contact_address ?? "");
    setCutoff(q.data.portal_reschedule_cutoff_hours ?? 18);
    setAllowResched(q.data.portal_allow_self_reschedule);
    setAllowHold(q.data.portal_allow_vacation_hold);
    setAllowFreq(q.data.portal_allow_frequency_change);
    setAutoApply(q.data.portal_auto_apply_changes);
  }, [q.data]);

  const mut = useMutation({
    mutationFn: () =>
      setFn({
        data: {
          brandColor: brandColor || null,
          logoUrl: logoUrl.trim() || null,
          contactPhone: contactPhone.trim() || null,
          contactEmail: contactEmail.trim() || null,
          contactAddress: contactAddress.trim() || null,
          portalRescheduleCutoffHours: cutoff,
          portalAllowSelfReschedule: allowResched,
          portalAllowVacationHold: allowHold,
          portalAllowFrequencyChange: allowFreq,
          portalAutoApplyChanges: autoApply,
        },
      }),
    onSuccess: () => {
      toast.success("Portal settings saved");
      qc.invalidateQueries({ queryKey: ["org-branding"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!canEdit) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Client portal branding & policy</CardTitle>
        <CardDescription>
          What your clients see on their portal: colors, logo, contact info, and what they can
          change themselves.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Brand color</Label>
            <div className="mt-1 flex gap-2">
              <Input
                type="color"
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                className="h-10 w-14 p-1"
              />
              <Input
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                placeholder="#16a34a"
              />
            </div>
          </div>
          <div>
            <Label className="text-xs">Logo URL</Label>
            <Input
              className="mt-1"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://…/logo.png"
            />
          </div>
          <div>
            <Label className="text-xs">Office phone (tap-to-call in the portal)</Label>
            <Input
              className="mt-1"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="+1 555 123 4567"
            />
          </div>
          <div>
            <Label className="text-xs">Office email</Label>
            <Input
              className="mt-1"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="hello@your-company.com"
            />
            {/* BUILD-5: this is the reply-to on every email your customers get.
                Without it their replies go to a noreply address nobody reads —
                and they get no bounce, so they believe they reached you. Said
                here rather than left as a blank optional field, because the
                cost of leaving it empty is invisible from this screen. */}
            {contactEmail.trim() ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Replies to invoices and reminders come back to this address.
              </p>
            ) : (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Add one. Invoices and reminders are sent from a no-reply address, so any customer
                who hits Reply today is writing to nobody.
              </p>
            )}
          </div>
          <div>
            <Label className="text-xs">Business address</Label>
            {/* Autocomplete over ONE free-text line, which is a deliberate
                pair of decisions.
                  Autocomplete, because the claim in the note below that
                nothing geocodes this stopped being true: org.functions.ts
                geocodes it on save, and staff_start_point falls back to the
                business location when a technician has no start address of
                their own (migration 20260815180000). A matched address is a
                pin the planner can trust; a hand-typed one is whatever
                Nominatim makes of it.
                  Still one line, because a PO box is a legitimate value here
                and the provider only matches street_address/premise — that
                tenant types their box number and saves it exactly as today.
                Splitting into street/city/state would lock them out for a
                field that is mostly printed in an email footer. */}
            <AddressAutocomplete
              className="mt-1"
              value={contactAddress}
              onChangeText={setContactAddress}
              onResolved={(r) => setContactAddress(r.address.formatted.slice(0, 300))}
              placeholder="123 Main St, Springfield, IL 62704"
              maxLength={300}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {contactAddress.trim()
                ? "Shown in the footer of emails to your customers."
                : "Optional, but it goes in the footer of your customer emails, and a service company with an address on it reads as a real local business."}
            </p>
          </div>
          <div>
            <Label className="text-xs">Change cutoff (hours before visit)</Label>
            <Input
              className="mt-1"
              type="number"
              min={0}
              max={168}
              value={cutoff}
              onChange={(e) => setCutoff(Math.max(0, Number(e.target.value) || 0))}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Below this window clients can no longer self-serve reschedule or skip.
            </p>
          </div>
        </div>

        <div className="border-t pt-4 space-y-3">
          <p className="text-sm font-medium">Self-serve permissions</p>
          <div className="flex items-center justify-between">
            <div className="text-sm">Allow clients to reschedule visits</div>
            <Switch checked={allowResched} onCheckedChange={setAllowResched} />
          </div>
          <div className="flex items-center justify-between">
            <div className="text-sm">Allow clients to request vacation holds</div>
            <Switch checked={allowHold} onCheckedChange={setAllowHold} />
          </div>
          <div className="flex items-center justify-between">
            <div className="text-sm">Allow clients to change plan frequency</div>
            <Switch checked={allowFreq} onCheckedChange={setAllowFreq} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm">Auto-apply requested changes</div>
              <div className="text-xs text-muted-foreground">
                Off (default): the office reviews every change. On: changes take effect immediately.
              </div>
            </div>
            <Switch checked={autoApply} onCheckedChange={setAutoApply} />
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? "Saving…" : "Save portal settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DemoDataCard() {
  const { role } = useMyRole();
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

  if (role !== "owner") return null;

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
