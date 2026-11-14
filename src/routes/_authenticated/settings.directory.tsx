import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Circle, ExternalLink, Plus, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
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
  type MyDirectoryBooking,
  type MyDirectoryProfile,
} from "@/lib/directory.functions";
import {
  BOOKING_POLICY_MAX,
  DIRECTORY_AREAS_MAX,
  DIRECTORY_AREA_NAME_MAX,
  DIRECTORY_DISCLOSURE,
  DIRECTORY_HIGHLIGHTS_MAX,
  DIRECTORY_HIGHLIGHT_MAX,
  DIRECTORY_TAGLINE_MAX,
  cleanHighlights,
  directoryContentProblems,
  directoryLineLabel,
  isDirectorySlug,
  oneLine,
  slugFromName,
  type DirectoryArea,
} from "@/lib/directory";
import { DIRECTORY_BRAND } from "@/lib/directory-site";
import { DirectoryPhotosSettings } from "@/components/directory/DirectoryPhotosSettings";

// Settings → Directory listing (#630, phase 1). The owner's opt-in to
// HoundStack's own directory: off by default, and nothing is public until
// the owner confirms every fact on this page and switches it on.
//
// What a visitor will see is exactly what is on this page: the name, the logo
// if the owner chooses, the bio, the services ticked with the price-from
// typed beside each, and the ZIPs and cities listed. No address, phone or
// email is ever shown; quotes arrive in Leads.
//
// The tagline, up to four highlights and up to eight named business areas
// (directory v2 5a) are on this page too.
//
// So is Book online (directory v2 step 7): a switch, off for every business
// until its owner turns it on, that lets the directory show "Book online"
// beside a service the booking link can sell right now. It needs the booking
// link on and Stripe able to take charges as well, and the section says which
// of the three is missing. Beside it, the owner's own cancellation and refund
// policy, shown before a visitor pays. Nothing is written for them. An area groups ZIPs the profile
// already covers, so its picker offers only the ZIPs listed below it.
//
// And Photos (directory v2 step 5b): up to eight, each with a description,
// uploaded only with the owner's attestation and held for review by
// HoundStack before it shows. Each photo saves on its own as it is uploaded
// (components/directory/DirectoryPhotosSettings.tsx).
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
  const [tagline, setTagline] = useState("");
  const [highlights, setHighlights] = useState<string[]>([]);
  const [areas, setAreas] = useState<DirectoryArea[]>([]);
  const [bookOnline, setBookOnline] = useState(false);
  const [bookingPolicy, setBookingPolicy] = useState("");

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
    setTagline(p?.tagline ?? "");
    setHighlights(p?.highlights ?? []);
    setAreas((p?.areas ?? []).map((a) => ({ name: a.name, zips: [...a.zips] })));
    setBookOnline(!!data.booking?.enabled);
    setBookingPolicy(data.booking?.policyText ?? "");
  }, [data]);

  const zipList = useMemo(() => splitList(zips), [zips]);
  const badZips = zipList.filter((z) => !/^\d{5}$/.test(z));
  const cityList = useMemo(() => splitList(cities), [cities]);
  const listedServices = (data?.services ?? []).filter((s) => s.active && choices[s.id]?.listed);
  const slugOk = isDirectorySlug(slug.trim().toLowerCase());
  const coveredZips = useMemo(
    () => Array.from(new Set(zipList.filter((z) => /^\d{5}$/.test(z)))).sort(),
    [zipList],
  );
  const contentProblems = directoryContentProblems({
    tagline,
    highlights,
    areas,
    coverageZips: coveredZips,
  });
  const problemsAt = (where: string) =>
    contentProblems.filter((p) => p.where === where).map((p) => p.message);

  const save = useMutation({
    mutationFn: (publish: boolean) =>
      saveFn({
        data: {
          slug: slug.trim().toLowerCase(),
          displayName: displayName.trim(),
          bio: bio.trim() || null,
          showLogo,
          coverageZips: coveredZips,
          coverageCities: cityList,
          services: listedServices.map((s) => ({
            serviceId: s.id,
            priceFromCents: cents(choices[s.id]?.price ?? ""),
          })),
          published: publish,
          tagline: oneLine(tagline) || null,
          highlights: cleanHighlights(highlights),
          areas: areas.map((a) => ({ name: oneLine(a.name), zips: a.zips })),
          // Sent only where the page could read them (#929): a page that
          // never saw the switch has no business writing it.
          ...(data?.booking?.available
            ? { bookOnline, bookingPolicyText: bookingPolicy.trim() || null }
            : {}),
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
  const policyTooLong = bookingPolicy.trim().length > BOOKING_POLICY_MAX;
  const contentProblem = contentProblems.length
    ? "Fix the highlighted tagline, highlights or areas first."
    : policyTooLong
      ? `Keep the cancellation and refund policy to ${BOOKING_POLICY_MAX} characters.`
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

        <TaglineAndHighlights
          tagline={tagline}
          onTagline={setTagline}
          highlights={highlights}
          onHighlights={setHighlights}
          taglineProblems={problemsAt("tagline")}
          highlightProblems={problemsAt("highlights")}
        />

        <DirectoryPhotosSettings disabled={!canEdit} />

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

        <BookOnline
          booking={data.booking ?? NO_BOOKING}
          enabled={bookOnline}
          onEnabled={setBookOnline}
          policy={bookingPolicy}
          onPolicy={setBookingPolicy}
        />

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

        <BusinessAreas
          areas={areas}
          onAreas={setAreas}
          coveredZips={coveredZips}
          problemsAt={problemsAt}
        />

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
              save.isPending ||
              (published && !!publishProblem) ||
              !slugOk ||
              !displayName.trim() ||
              !!contentProblem
            }
          >
            {save.isPending ? "Saving…" : published ? "Save and publish" : "Save, not listed"}
          </Button>
          {contentProblem || (published && publishProblem) ? (
            <p className="min-w-0 text-sm text-muted-foreground">
              {contentProblem ?? publishProblem}
            </p>
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

/** What the page reads when the server said nothing about booking (an older
 *  server answering during a deploy): off, and not available to turn on. */
const NO_BOOKING: MyDirectoryBooking = {
  available: false,
  enabled: false,
  policyText: "",
  publicSignupEnabled: false,
  chargesEnabled: false,
};

/** Book online on the directory (step 7): the switch, what else it needs,
 *  and the owner's own cancellation and refund policy. */
function BookOnline({
  booking,
  enabled,
  onEnabled,
  policy,
  onPolicy,
}: {
  booking: MyDirectoryBooking;
  enabled: boolean;
  onEnabled: (v: boolean) => void;
  policy: string;
  onPolicy: (v: string) => void;
}) {
  const policyLength = policy.trim().length;
  const tooLong = policyLength > BOOKING_POLICY_MAX;
  const needs: Array<{ done: boolean; label: string; to: string; action: string }> = [
    {
      done: booking.publicSignupEnabled,
      label: "Your booking link takes signups online",
      to: "/settings/online-signup",
      action: "Turn it on",
    },
    {
      done: booking.chargesEnabled,
      label: "Stripe can take card payments",
      to: "/payments",
      action: "Set up Stripe",
    },
  ];
  const ready = needs.every((n) => n.done);
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" data-directory-book-online>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="font-medium">
            <label htmlFor="dir-book-online">Show Book online on {DIRECTORY_BRAND}</label>
          </h3>
          <p className="text-xs text-muted-foreground">
            Book online appears beside a service only when this is on, your booking link takes
            signups online, and Stripe can take card payments. Each service's own setting in
            Services decides how it is sold. Otherwise visitors still see Request a quote.
          </p>
        </div>
        <Switch
          id="dir-book-online"
          checked={enabled}
          onCheckedChange={onEnabled}
          disabled={!booking.available}
        />
      </div>
      {!booking.available ? (
        <p className="text-sm text-muted-foreground">
          Book online isn't available for your account yet. Visitors see Request a quote.
        </p>
      ) : null}
      <ul className="space-y-1" aria-label="What Book online also needs">
        {needs.map((n) => (
          <li
            key={n.label}
            className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 text-sm"
          >
            <span className="flex min-w-0 flex-1 basis-56 items-center gap-2">
              {n.done ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              ) : (
                <Circle className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="min-w-0">
                {n.label}
                <span className="sr-only">{n.done ? ": done" : ": not yet"}</span>
              </span>
            </span>
            {n.done ? null : (
              <Button asChild variant="outline" size="sm" className="shrink-0">
                <Link to={n.to}>{n.action}</Link>
              </Button>
            )}
          </li>
        ))}
      </ul>
      {enabled && !ready ? (
        <p className="text-sm text-muted-foreground" role="status">
          Saved as on. Visitors keep seeing Request a quote until both of the above are done.
        </p>
      ) : null}
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor="dir-booking-policy">Cancellation and refund policy</Label>
          <span
            className={`shrink-0 text-xs tabular-nums ${tooLong ? "text-destructive" : "text-muted-foreground"}`}
            aria-live="polite"
          >
            {policyLength}/{BOOKING_POLICY_MAX}
          </span>
        </div>
        <Textarea
          id="dir-booking-policy"
          rows={3}
          value={policy}
          onChange={(e) => onPolicy(e.target.value)}
          placeholder="In your own words, for example how much notice you need to cancel and what is refunded."
          aria-invalid={tooLong}
          aria-describedby="dir-booking-policy-hint"
        />
        <p id="dir-booking-policy-hint" className="text-xs text-muted-foreground">
          Optional. Shown to a pet owner before they pay. Leave it empty if you don't have one: we
          never write a policy for you.
        </p>
      </div>
    </section>
  );
}

function Problems({ id, messages }: { id?: string; messages: string[] }) {
  if (!messages.length) return null;
  return (
    <ul id={id} className="space-y-0.5 text-xs text-destructive" role="alert">
      {messages.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

function TaglineAndHighlights({
  tagline,
  onTagline,
  highlights,
  onHighlights,
  taglineProblems,
  highlightProblems,
}: {
  tagline: string;
  onTagline: (v: string) => void;
  highlights: string[];
  onHighlights: (v: string[]) => void;
  taglineProblems: string[];
  highlightProblems: string[];
}) {
  const taglineLength = oneLine(tagline).length;
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div>
        <h3 className="font-medium">Tagline and highlights</h3>
        <p className="text-xs text-muted-foreground">
          One line under your name, and up to {DIRECTORY_HIGHLIGHTS_MAX} short points a pet owner
          can scan. Both are optional.
        </p>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor="dir-tagline">Tagline</Label>
          <span
            className={`shrink-0 text-xs tabular-nums ${taglineLength > DIRECTORY_TAGLINE_MAX ? "text-destructive" : "text-muted-foreground"}`}
            aria-live="polite"
          >
            {taglineLength}/{DIRECTORY_TAGLINE_MAX}
          </span>
        </div>
        <Input
          id="dir-tagline"
          value={tagline}
          onChange={(e) => onTagline(e.target.value)}
          placeholder="Small-pack walks with the same walker every week"
          aria-invalid={taglineProblems.length > 0}
          aria-describedby={taglineProblems.length ? "dir-tagline-problems" : undefined}
        />
        <Problems id="dir-tagline-problems" messages={taglineProblems} />
      </div>
      <div className="space-y-2">
        <Label>Highlights</Label>
        {highlights.length ? (
          <ul className="space-y-2">
            {highlights.map((h, i) => {
              const len = oneLine(h).length;
              return (
                <li key={i} className="flex items-center gap-2">
                  <Input
                    aria-label={`Highlight ${i + 1}`}
                    className="min-w-0 flex-1"
                    value={h}
                    onChange={(e) =>
                      onHighlights(highlights.map((x, j) => (j === i ? e.target.value : x)))
                    }
                    placeholder="Insured and bonded"
                    aria-invalid={len > DIRECTORY_HIGHLIGHT_MAX}
                  />
                  <span
                    className={`w-12 shrink-0 text-end text-xs tabular-nums ${len > DIRECTORY_HIGHLIGHT_MAX ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {len}/{DIRECTORY_HIGHLIGHT_MAX}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove highlight ${i + 1}`}
                    onClick={() => onHighlights(highlights.filter((_, j) => j !== i))}
                  >
                    <X className="h-4 w-4 shrink-0" aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No highlights yet.</p>
        )}
        <Problems messages={highlightProblems} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={highlights.length >= DIRECTORY_HIGHLIGHTS_MAX}
          onClick={() => onHighlights([...highlights, ""])}
        >
          <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
          {highlights.length >= DIRECTORY_HIGHLIGHTS_MAX
            ? `${DIRECTORY_HIGHLIGHTS_MAX} highlights is the most`
            : "Add highlight"}
        </Button>
      </div>
    </section>
  );
}

function BusinessAreas({
  areas,
  onAreas,
  coveredZips,
  problemsAt,
}: {
  areas: DirectoryArea[];
  onAreas: (v: DirectoryArea[]) => void;
  coveredZips: string[];
  problemsAt: (where: string) => string[];
}) {
  const set = (i: number, a: DirectoryArea) => onAreas(areas.map((x, j) => (j === i ? a : x)));
  const full = areas.length >= DIRECTORY_AREAS_MAX;
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div>
        <h3 className="font-medium">Business areas</h3>
        <p className="text-xs text-muted-foreground">
          Optional. Group the ZIP codes you cover into up to {DIRECTORY_AREAS_MAX} named areas, like
          "Downtown" or "North suburbs", so a pet owner can see at a glance where you work. Only
          ZIPs listed above can go in an area.
        </p>
      </div>
      <Problems messages={problemsAt("areas")} />
      {areas.length ? (
        <ul className="space-y-3">
          {areas.map((a, i) => (
            <AreaEditor
              key={i}
              index={i}
              area={a}
              coveredZips={coveredZips}
              problems={problemsAt(`area-${i}`)}
              onChange={(next) => set(i, next)}
              onRemove={() => onAreas(areas.filter((_, j) => j !== i))}
            />
          ))}
        </ul>
      ) : null}
      {!coveredZips.length ? (
        <p className="text-sm text-muted-foreground">
          List the ZIP codes you cover above, then group them here.
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={full || !coveredZips.length}
        onClick={() => onAreas([...areas, { name: "", zips: [] }])}
      >
        <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
        {full ? `${DIRECTORY_AREAS_MAX} areas is the most` : "Add area"}
      </Button>
    </section>
  );
}

function AreaEditor({
  index,
  area,
  coveredZips,
  problems,
  onChange,
  onRemove,
}: {
  index: number;
  area: DirectoryArea;
  coveredZips: string[];
  problems: string[];
  onChange: (a: DirectoryArea) => void;
  onRemove: () => void;
}) {
  const id = `dir-area-${index}`;
  const picked = new Set(area.zips);
  // A ZIP still in the area but no longer covered is shown, marked, so the
  // owner can see why the area is refused and untick it.
  const stale = area.zips.filter((z) => !coveredZips.includes(z));
  const toggle = (z: string) =>
    onChange({
      ...area,
      zips: picked.has(z) ? area.zips.filter((x) => x !== z) : [...area.zips, z].sort(),
    });
  const nameLength = oneLine(area.name).length;
  return (
    <li className="space-y-3 rounded-md border p-3">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <Label id={`${id}-label`} htmlFor={`${id}-name`}>
              Area {index + 1} name
            </Label>
            <span
              className={`shrink-0 text-xs tabular-nums ${nameLength > DIRECTORY_AREA_NAME_MAX ? "text-destructive" : "text-muted-foreground"}`}
            >
              {nameLength}/{DIRECTORY_AREA_NAME_MAX}
            </span>
          </div>
          <Input
            id={`${id}-name`}
            value={area.name}
            onChange={(e) => onChange({ ...area, name: e.target.value })}
            placeholder="Downtown"
            aria-invalid={problems.length > 0}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Remove area ${index + 1}`}
          onClick={onRemove}
        >
          <X className="h-4 w-4 shrink-0" aria-hidden="true" />
        </Button>
      </div>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">
            ZIP codes{" "}
            <span className="font-normal text-muted-foreground">
              ({area.zips.length} of {coveredZips.length})
            </span>
          </span>
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange({ ...area, zips: [...coveredZips] })}
            >
              All
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange({ ...area, zips: [] })}
            >
              None
            </Button>
          </div>
        </div>
        <div
          role="group"
          aria-label={`ZIP codes in area ${index + 1}`}
          className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto"
          dir="ltr"
        >
          {coveredZips.map((z) => (
            <Button
              key={z}
              type="button"
              size="sm"
              variant={picked.has(z) ? "default" : "outline"}
              aria-pressed={picked.has(z)}
              className="tabular-nums"
              onClick={() => toggle(z)}
            >
              {z}
            </Button>
          ))}
          {stale.map((z) => (
            <Button
              key={`stale-${z}`}
              type="button"
              size="sm"
              variant="destructive"
              aria-pressed={true}
              aria-label={`${z}, not covered: remove from this area`}
              className="gap-1 tabular-nums"
              onClick={() => toggle(z)}
            >
              {z}
              <X className="h-3 w-3 shrink-0" aria-hidden="true" />
            </Button>
          ))}
        </div>
      </div>
      <Problems messages={problems} />
    </li>
  );
}
