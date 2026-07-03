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

      <DemoDataCard />
    </div>
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

