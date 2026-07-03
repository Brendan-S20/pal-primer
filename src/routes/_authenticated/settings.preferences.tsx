import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { setLanguage, currentLanguage } from "@/lib/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useMyRole } from "@/hooks/useMyRole";
import { reseedDemoData } from "@/lib/demo.functions";
import { getOrgBranding, updateOrgBranding } from "@/lib/org.functions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";

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
    <div className="space-y-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Language</CardTitle>
          <CardDescription>
            Applies across the app, including the tech's My Day view.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="lang" className="text-xs">Interface language</Label>
          <Select
            value={lang}
            onValueChange={(v) => {
              setLang(v);
              setLanguage(v as "en" | "es");
              i18n.changeLanguage(v);
              toast.success(t("common.language") + " updated");
            }}
          >
            <SelectTrigger id="lang" className="mt-1 w-56"><SelectValue /></SelectTrigger>
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
              onCheckedChange={(v) => { setHaptics(v); setBool(HAPTICS_KEY, v); }}
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
              onCheckedChange={(v) => { setAwake(v); setBool(AWAKE_KEY, v); }}
            />
          </div>
          <div>
            <Label htmlFor="map" className="text-xs">Default map app for directions</Label>
            <Select
              value={mapApp}
              onValueChange={(v) => { setMapApp(v); window.localStorage.setItem(MAP_KEY, v); }}
            >
              <SelectTrigger id="map" className="mt-1 w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="google">Google Maps</SelectItem>
                <SelectItem value="apple">Apple Maps</SelectItem>
                <SelectItem value="waze">Waze</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <BrandingCard />
      <DemoDataCard />
    </div>
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
    setCutoff(q.data.portal_reschedule_cutoff_hours ?? 18);
    setAllowResched(q.data.portal_allow_self_reschedule);
    setAllowHold(q.data.portal_allow_vacation_hold);
    setAllowFreq(q.data.portal_allow_frequency_change);
    setAutoApply(q.data.portal_auto_apply_changes);
  }, [q.data]);

  const mut = useMutation({
    mutationFn: () => setFn({ data: {
      brandColor: brandColor || null,
      logoUrl: logoUrl.trim() || null,
      contactPhone: contactPhone.trim() || null,
      contactEmail: contactEmail.trim() || null,
      portalRescheduleCutoffHours: cutoff,
      portalAllowSelfReschedule: allowResched,
      portalAllowVacationHold: allowHold,
      portalAllowFrequencyChange: allowFreq,
      portalAutoApplyChanges: autoApply,
    } }),
    onSuccess: () => { toast.success("Portal settings saved"); qc.invalidateQueries({ queryKey: ["org-branding"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!canEdit) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Client portal branding & policy</CardTitle>
        <CardDescription>
          What your clients see on their portal — colors, logo, contact info, and what they can change themselves.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Brand color</Label>
            <div className="mt-1 flex gap-2">
              <Input type="color" value={brandColor} onChange={(e) => setBrandColor(e.target.value)} className="h-10 w-14 p-1" />
              <Input value={brandColor} onChange={(e) => setBrandColor(e.target.value)} placeholder="#16a34a" />
            </div>
          </div>
          <div>
            <Label className="text-xs">Logo URL</Label>
            <Input className="mt-1" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://…/logo.png" />
          </div>
          <div>
            <Label className="text-xs">Office phone (tap-to-call in the portal)</Label>
            <Input className="mt-1" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)}
              placeholder="+1 555 123 4567" />
          </div>
          <div>
            <Label className="text-xs">Office email</Label>
            <Input className="mt-1" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)}
              placeholder="hello@your-company.com" />
          </div>
          <div>
            <Label className="text-xs">Change cutoff (hours before visit)</Label>
            <Input className="mt-1" type="number" min={0} max={168} value={cutoff}
              onChange={(e) => setCutoff(Math.max(0, Number(e.target.value) || 0))} />
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
  const reseedFn = useServerFn(reseedDemoData);
  const mut = useMutation({
    mutationFn: () => reseedFn({ data: {} }),
    onSuccess: (r) => {
      toast.success(`Demo reset — ${r.clients} clients, ${r.visits_created} visits, ${r.invoices_created} invoices`);
      setTimeout(() => window.location.reload(), 1500);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (role !== "owner") return null;

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle>Demo data</CardTitle>
        <CardDescription>
          Wipes your organization's demo rows and rebuilds a rich fixture:
          6 clients (residential + HOA), zones, sketched yards, subscriptions,
          8 weeks of visits (including weather reschedules and skips), invoices in
          multiple states, promo codes, a gift card, referrals, and QC tickets.
          Safe to run repeatedly.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button
          variant="destructive"
          disabled={mut.isPending}
          onClick={() => {
            if (confirm("Wipe and reseed demo data for this organization?")) mut.mutate();
          }}
        >
          {mut.isPending ? "Reseeding…" : "Reseed demo data"}
        </Button>
      </CardContent>
    </Card>
  );
}

