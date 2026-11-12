import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { titleHead } from "@/lib/page-title";
import {
  getMyDirectoryProfile,
  saveMyDirectoryProfile,
  type MyDirectoryProfile,
} from "@/lib/directory.functions";
import {
  DIRECTORY_DISCLOSURE,
  directoryLineLabel,
  isDirectorySlug,
  slugFromName,
} from "@/lib/directory";

// Settings → Directory listing (#630, phase 1). The owner's opt-in to
// HoundStack's own directory: off by default, and nothing is public until
// the owner confirms every fact on this page and switches it on.
//
// What a visitor will see is exactly what is on this page: the name, the logo
// if the owner chooses, the bio, the services ticked with the price-from
// typed beside each, and the ZIPs and cities listed. No address, phone or
// email is ever shown; quotes arrive in Leads.
//
// Its own page rather than a section of Business defaults (#709 is editing
// settings.business.tsx). Only an owner can save; the server and the
// database both check.

export const Route = createFileRoute("/_authenticated/settings/directory")({
  head: () => titleHead("Directory listing", "Settings"),
  component: DirectorySettings,
});

type ServiceChoice = { listed: boolean; price: string };

const dollars = (cents: number | null | undefined) =>
  cents == null ? "" : (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
const cents = (s: string): number | null => {
  const t = s.trim().replace(/^\$/, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const splitList = (s: string) =>
  s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function DirectorySettings() {
  const qc = useQueryClient();
  const getFn = useServerFn(getMyDirectoryProfile);
  const saveFn = useServerFn(saveMyDirectoryProfile);
  const { data, isLoading, error } = useQuery({
    queryKey: ["my-directory-profile"],
    queryFn: () => getFn({}),
  });

  const [published, setPublished] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [bio, setBio] = useState("");
  const [showLogo, setShowLogo] = useState(false);
  const [zips, setZips] = useState("");
  const [cities, setCities] = useState("");
  const [choices, setChoices] = useState<Record<string, ServiceChoice>>({});
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!data) return;
    const p = data.profile;
    setPublished(!!p?.published);
    setDisplayName(p?.display_name ?? data.orgName);
    setSlug(p?.slug ?? slugFromName(data.orgName || "my-business"));
    setBio(p?.bio ?? "");
    setShowLogo(!!p?.show_logo);
    setZips((p?.coverage_zips ?? data.zoneZips).join(", "));
    setCities((p?.coverage_cities ?? []).join(", "));
    const listed = new Map((p?.listed ?? []).map((l) => [l.service_id, l.price_from_cents]));
    setChoices(
      Object.fromEntries(
        data.services.map((s) => [
          s.id,
          {
            listed: listed.has(s.id),
            price: dollars(listed.has(s.id) ? listed.get(s.id) : s.base_price_cents),
          },
        ]),
      ),
    );
    setConfirmed(!!p?.published);
  }, [data]);

  const zipList = useMemo(() => splitList(zips), [zips]);
  const badZips = zipList.filter((z) => !/^\d{5}$/.test(z));
  const cityList = useMemo(() => splitList(cities), [cities]);
  const listedServices = (data?.services ?? []).filter((s) => s.active && choices[s.id]?.listed);
  const slugOk = isDirectorySlug(slug.trim().toLowerCase());

  const save = useMutation({
    mutationFn: (publish: boolean) =>
      saveFn({
        data: {
          slug: slug.trim().toLowerCase(),
          displayName: displayName.trim(),
          bio: bio.trim() || null,
          showLogo,
          coverageZips: zipList.filter((z) => /^\d{5}$/.test(z)),
          coverageCities: cityList,
          services: listedServices.map((s) => ({
            serviceId: s.id,
            priceFromCents: cents(choices[s.id]?.price ?? ""),
          })),
          published: publish,
        },
      }),
    onSuccess: (_r, publish) => {
      toast.success(publish ? "Your profile is live in the directory" : "Saved. Not listed.");
      qc.invalidateQueries({ queryKey: ["my-directory-profile"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (error || !data) return <p>Couldn't load your directory listing. Try again in a moment.</p>;
  const canEdit = data.canEdit;
  const profileUrl = `/pros/${encodeURIComponent(data.profile?.slug ?? "")}`;
  const publishProblem = !slugOk
    ? "Choose a web address of 3 to 60 lowercase letters, numbers and dashes."
    : !displayName.trim()
      ? "Add the name to show."
      : !listedServices.length
        ? "Tick at least one service."
        : !zipList.length || badZips.length
          ? "List the 5-digit ZIP codes you cover."
          : !confirmed
            ? "Confirm the details before you publish."
            : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Directory listing</h2>
          <p className="text-sm text-muted-foreground">
            A free profile in HoundStack's directory, where pet owners search by service and ZIP,
            compare businesses and ask for a quote. Quotes arrive in Leads. Off until you switch it
            on.
          </p>
        </div>
        {data.profile?.published ? (
          <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
            <a href={profileUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
              View profile
            </a>
          </Button>
        ) : null}
      </div>

      {!canEdit ? (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm">
          Only an owner can change the directory listing.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
        <div className="min-w-0">
          <div className="font-medium">
            {data.profile?.published ? "Listed in the directory" : "Not listed"}
          </div>
          <div className="text-xs text-muted-foreground">
            {data.profile?.published
              ? "Visitors can find this profile and send you quote requests."
              : "Nothing on this page is public until you publish."}
          </div>
        </div>
        <Switch
          checked={published}
          onCheckedChange={setPublished}
          disabled={!canEdit}
          aria-label="List my business in the directory"
        />
      </div>

      <fieldset disabled={!canEdit} className="space-y-6">
        <div className="grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="dir-name">Name to show</Label>
            <Input
              id="dir-name"
              value={displayName}
              maxLength={120}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dir-slug">Web address</Label>
            <Input
              id="dir-slug"
              value={slug}
              maxLength={60}
              onChange={(e) => setSlug(e.target.value)}
              aria-invalid={!slugOk}
            />
            <p className="text-xs break-all text-muted-foreground" dir="ltr">
              /pros/{slug.trim().toLowerCase() || "…"}
            </p>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="dir-bio">About your business</Label>
            <Textarea
              id="dir-bio"
              rows={4}
              maxLength={1200}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Who you are, how long you've been doing this, what makes you different. No phone numbers or addresses: quotes come through the form."
            />
          </div>
          <label className="flex min-h-11 items-center gap-3 md:col-span-2">
            <Checkbox
              checked={showLogo}
              onCheckedChange={(v) => setShowLogo(v === true)}
              disabled={!data.hasLogo || !canEdit}
            />
            <span className="min-w-0 text-sm">
              Show my logo{data.hasLogo ? "" : " (add one in Client portal settings first)"}
            </span>
          </label>
        </div>

        <section className="space-y-3 rounded-lg border bg-card p-4">
          <div>
            <h3 className="font-medium">Services and prices from</h3>
            <p className="text-xs text-muted-foreground">
              Tick what to list. Leave a price empty to show "Ask for a quote". A service you don't
              tick stays hidden.
            </p>
          </div>
          {data.services.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Add services in Settings → Services first.
            </p>
          ) : (
            <ul className="divide-y">
              {data.services.map((s) => (
                <ServiceRow
                  key={s.id}
                  service={s}
                  choice={choices[s.id] ?? { listed: false, price: "" }}
                  onChange={(c) => setChoices((all) => ({ ...all, [s.id]: c }))}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="dir-zips">ZIP codes you cover</Label>
              {data.zoneZips.length ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setZips(data.zoneZips.join(", "))}
                >
                  Use my zones' ZIPs
                </Button>
              ) : null}
            </div>
            <Textarea
              id="dir-zips"
              rows={3}
              value={zips}
              onChange={(e) => setZips(e.target.value)}
              placeholder="48201, 48202"
              dir="ltr"
            />
            {badZips.length ? (
              <p className="text-xs text-destructive">
                Not a 5-digit ZIP: <span dir="ltr">{badZips.slice(0, 5).join(", ")}</span>
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dir-cities">Cities you cover</Label>
            <Textarea
              id="dir-cities"
              rows={3}
              value={cities}
              onChange={(e) => setCities(e.target.value)}
              placeholder="Detroit, Ferndale"
            />
            <p className="text-xs text-muted-foreground">
              City names only, never a street address.
            </p>
          </div>
        </section>

        <div className="space-y-3 rounded-lg border bg-card p-4">
          <label className="flex min-h-11 items-start gap-3">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(v) => setConfirmed(v === true)}
              className="mt-0.5"
            />
            <span className="min-w-0 text-sm">
              I confirm these details are accurate and I want them shown publicly in HoundStack's
              directory. HoundStack shows only what is on this page.
            </span>
          </label>
          <p className="text-xs text-muted-foreground">{DIRECTORY_DISCLOSURE}</p>
        </div>
      </fieldset>

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => save.mutate(published)}
            disabled={
              save.isPending || (published && !!publishProblem) || !slugOk || !displayName.trim()
            }
          >
            {save.isPending ? "Saving…" : published ? "Save and publish" : "Save, not listed"}
          </Button>
          {published && publishProblem ? (
            <p className="min-w-0 text-sm text-muted-foreground">{publishProblem}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ServiceRow({
  service: s,
  choice,
  onChange,
}: {
  service: MyDirectoryProfile["services"][number];
  choice: ServiceChoice;
  onChange: (c: ServiceChoice) => void;
}) {
  const id = `dir-svc-${s.id}`;
  return (
    <li className="flex flex-wrap items-center gap-3 py-2">
      <label htmlFor={id} className="flex min-h-11 min-w-0 flex-1 basis-56 items-center gap-3">
        <Checkbox
          id={id}
          checked={choice.listed && s.active}
          // A retired service cannot be listed: the directory shows what the
          // business sells today, and the database drops it anyway.
          disabled={!s.active}
          onCheckedChange={(v) => onChange({ ...choice, listed: v === true })}
        />
        <span className="min-w-0">
          <span className="block font-medium break-words">{s.name}</span>
          <span className="block text-xs text-muted-foreground">
            {directoryLineLabel(s.service_line)}
            {s.active ? "" : " · not currently sold, so it can't be listed"}
          </span>
        </span>
      </label>
      <div className="flex shrink-0 items-center gap-2 ps-7 sm:ps-0">
        <Label htmlFor={`${id}-price`} className="text-xs text-muted-foreground">
          From $
        </Label>
        <Input
          id={`${id}-price`}
          inputMode="decimal"
          className="w-28"
          value={choice.price}
          disabled={!choice.listed || !s.active}
          onChange={(e) => onChange({ ...choice, price: e.target.value })}
          placeholder="Ask"
        />
        <span className="text-xs text-muted-foreground">
          {s.price_unit ? `/ ${s.price_unit}` : ""}
        </span>
      </div>
    </li>
  );
}
