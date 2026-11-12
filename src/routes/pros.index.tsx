import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Check, MapPin, Plus, Search } from "lucide-react";
import { DirectoryShell } from "@/components/directory/DirectoryShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { searchDirectory } from "@/lib/directory.functions";
import {
  DIRECTORY_LINE_LABEL,
  DIRECTORY_SEARCH_LINES,
  MAX_COMPARE,
  cleanZip,
  coverageLabel,
  directoryHead,
  directoryLineLabel,
  isDirectorySearchLine,
  lowestPriceFrom,
  priceFromLabel,
  type DirectoryProfile,
  type DirectorySearchLine,
} from "@/lib/directory";
import { DIRECTORY_BRAND, directoryOrigin } from "@/lib/directory-site";
import { DIRECTORY_HERO_PHOTO, DIRECTORY_LINE_PHOTO } from "@/lib/directory-brand";
import { DirectoryPhotoCredits, DirectoryPicture } from "@/components/directory/DirectoryPhotos";
import { pageTitle } from "@/lib/page-title";

// HoundStack's directory, the search (#630, phase 1): pick a service, type a
// ZIP, see the businesses that opted in and confirmed that ZIP. Tick up to
// three to compare. A plain GET form, so the search works before (and
// without) JavaScript, and a result page is a link that can be shared.
//
// noindex + self-canonical, set here and not in __root.tsx: see
// directoryHead in lib/directory.ts for the per-city INDEXABLE flag, which
// is off.

type Search = { line?: DirectorySearchLine; zip?: string };

export const Route = createFileRoute("/pros/")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    line: isDirectorySearchLine(s.line) ? s.line : undefined,
    zip: cleanZip(typeof s.zip === "number" ? String(s.zip) : s.zip) ?? undefined,
  }),
  loaderDeps: ({ search }) => ({ line: search.line, zip: search.zip }),
  // Searched on the SERVER when the URL names a search, so the HTML already
  // carries the results. A lookup that fails is `null` and the browser asks
  // again; it is never reported as "no results".
  loader: async ({ deps }) => {
    if (!deps.line || !deps.zip) return { profiles: null as DirectoryProfile[] | null };
    try {
      const r = await searchDirectory({ data: { line: deps.line, zip: deps.zip } });
      return { profiles: r.profiles };
    } catch {
      return { profiles: null as DirectoryProfile[] | null };
    }
  },
  head: () =>
    directoryHead({
      title: pageTitle("Find a pet pro", DIRECTORY_BRAND),
      description:
        "Find a pet service business near you, compare up to three, and ask for a quote. Every business listed is a HoundStack customer that chose to be listed.",
      path: "/pros",
      origin: directoryOrigin(),
    }),
  component: DirectorySearch,
});

function DirectorySearch() {
  const search = Route.useSearch();
  const { profiles: loaded } = Route.useLoaderData();
  const navigate = useNavigate();
  const run = useServerFn(searchDirectory);
  const [picked, setPicked] = useState<string[]>([]);
  const asked = !!(search.line && search.zip);

  const q = useQuery({
    queryKey: ["directory-search", search.line ?? null, search.zip ?? null],
    queryFn: () => run({ data: { line: search.line!, zip: search.zip! } }).then((r) => r.profiles),
    enabled: asked,
    initialData: loaded ?? undefined,
    staleTime: 60_000,
    retry: false,
  });

  const toggle = (slug: string) =>
    setPicked((p) =>
      p.includes(slug) ? p.filter((s) => s !== slug) : p.length >= MAX_COMPARE ? p : [...p, slug],
    );

  return (
    <DirectoryShell>
      <div className="space-y-8">
        <div className="grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-10">
          <div className="min-w-0 space-y-3">
            <h1 className="text-3xl tracking-tight break-words sm:text-4xl lg:text-5xl">
              Find a pet pro near you
            </h1>
            <p className="max-w-2xl text-lg text-foreground">
              Walkers, sitters, groomers, trainers and pet waste removal, near you. Listing is free
              for HoundStack businesses.
            </p>
            <p className="max-w-2xl text-muted-foreground">
              Search by service and ZIP code, compare up to three businesses, and ask the ones you
              like for a quote. Nobody pays to be listed here.
            </p>
          </div>
          <figure className="min-w-0" data-directory-hero>
            <div className="aspect-[16/9] overflow-hidden rounded-2xl border bg-muted sm:aspect-[3/2]">
              <DirectoryPicture photo={DIRECTORY_HERO_PHOTO} eager />
            </div>
            <figcaption className="mt-1 text-xs text-muted-foreground">
              Photo: {DIRECTORY_HERO_PHOTO.credit} on Pexels
            </figcaption>
          </figure>
        </div>

        <form
          method="get"
          action="/pros"
          className="space-y-4 rounded-2xl border bg-card p-4 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const line = String(f.get("line") ?? "");
            const zip = cleanZip(String(f.get("zip") ?? ""));
            setPicked([]);
            navigate({
              to: "/pros",
              search: {
                line: isDirectorySearchLine(line) ? line : undefined,
                zip: zip ?? undefined,
              },
            });
          }}
        >
          <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm font-medium">Service</legend>
            {/* All five, the same size, none of them first by default (#898):
                the directory is for every kind of pet pro, not one trade. */}
            <div className="grid gap-3 sm:grid-cols-5" data-directory-services>
              {DIRECTORY_SEARCH_LINES.map((l) => (
                <ServiceTile key={l} line={l} checked={search.line === l} />
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_max-content] sm:items-end sm:justify-start">
            <label className="grid min-w-0 gap-1 text-sm font-medium">
              Their ZIP code
              <Input
                name="zip"
                inputMode="numeric"
                autoComplete="postal-code"
                pattern="[0-9]{5}"
                maxLength={5}
                required
                defaultValue={search.zip ?? ""}
                placeholder="48201"
                className="h-11 bg-background"
              />
            </label>
            <Button type="submit" className="h-11 gap-2">
              <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
              Search
            </Button>
          </div>
        </form>

        {!asked ? (
          <p className="text-sm text-muted-foreground">
            Pick a service and enter your ZIP code to see who works in your area.
          </p>
        ) : q.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Searching…
          </p>
        ) : q.error ? (
          <p className="text-sm text-muted-foreground" role="status">
            The directory isn't available right now. Please try again in a moment.
          </p>
        ) : (q.data ?? []).length === 0 ? (
          <div className="rounded-lg border p-6 text-center" data-directory-empty>
            <p className="font-medium">
              No {directoryLineLabel(search.line!).toLowerCase()} businesses are listed for{" "}
              <span dir="ltr">{search.zip}</span> yet.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Try a nearby ZIP code or another service.
            </p>
          </div>
        ) : (
          <section aria-labelledby="results-heading" className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="results-heading" className="text-lg font-semibold">
                {q.data!.length} {q.data!.length === 1 ? "business" : "businesses"} for{" "}
                {directoryLineLabel(search.line!).toLowerCase()} in{" "}
                <span dir="ltr">{search.zip}</span>
              </h2>
              <p className="text-sm text-muted-foreground">Tick up to {MAX_COMPARE} to compare.</p>
            </div>
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {q.data!.map((p) => (
                <ResultCard
                  key={p.slug}
                  profile={p}
                  line={search.line!}
                  picked={picked.includes(p.slug)}
                  full={picked.length >= MAX_COMPARE}
                  onToggle={() => toggle(p.slug)}
                />
              ))}
            </ul>
          </section>
        )}

        {picked.length > 0 && (
          <div className="sticky bottom-0 z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                {picked.length} of {MAX_COMPARE} picked to compare
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setPicked([])}>
                  Clear
                </Button>
                {picked.length < 2 ? (
                  <Button disabled>Pick one more to compare</Button>
                ) : (
                  <Button asChild>
                    <Link
                      to="/pros/compare"
                      search={{ slugs: picked.join(","), line: search.line }}
                      data-directory-compare
                    >
                      Compare {picked.length}
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        <DirectoryPhotoCredits photos={SEARCH_PAGE_PHOTOS} />
      </div>
    </DirectoryShell>
  );
}

/** The photos this page shows, in the order they appear: the hero, then the
 *  five services. Each gets a visible credit. */
const SEARCH_PAGE_PHOTOS = [
  DIRECTORY_HERO_PHOTO,
  ...DIRECTORY_SEARCH_LINES.map((l) => DIRECTORY_LINE_PHOTO[l]),
];

/**
 * One service as a choice: a radio the size of the whole tile (so the tap
 * target is the tile, and a plain GET form submits it without JavaScript),
 * the service's photo, and its name. A row on a phone, a column of five from
 * 640 up; every tile the same size either way.
 */
function ServiceTile({ line, checked }: { line: DirectorySearchLine; checked: boolean }) {
  const label = DIRECTORY_LINE_LABEL[line];
  return (
    <label
      className="relative flex min-h-11 min-w-0 items-center gap-3 overflow-hidden rounded-xl border bg-background p-2 has-[:checked]:border-primary has-[:checked]:bg-muted has-[:checked]:ring-2 has-[:checked]:ring-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring sm:flex-col sm:items-stretch sm:gap-2"
      data-directory-service={line}
    >
      <input
        type="radio"
        name="line"
        value={line}
        defaultChecked={checked}
        required
        className="absolute inset-0 z-10 m-0 h-full w-full cursor-pointer appearance-none rounded-xl opacity-0"
      />
      <span className="aspect-[4/3] w-20 shrink-0 overflow-hidden rounded-lg bg-muted sm:w-full">
        <DirectoryPicture photo={DIRECTORY_LINE_PHOTO[line]} />
      </span>
      <span className="min-w-0 text-sm font-semibold break-words sm:px-1 sm:pb-1">{label}</span>
    </label>
  );
}

function ResultCard({
  profile: p,
  line,
  picked,
  full,
  onToggle,
}: {
  profile: DirectoryProfile;
  line: DirectorySearchLine;
  picked: boolean;
  full: boolean;
  onToggle: () => void;
}) {
  const from = lowestPriceFrom(p, line);
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4" data-directory-result>
      <div className="flex min-w-0 items-start gap-3">
        {p.logo_url ? (
          <img
            src={p.logo_url}
            alt=""
            className="h-12 w-12 shrink-0 rounded-md border object-contain"
            loading="lazy"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold break-words">
            <Link
              to="/pros/$slug"
              params={{ slug: p.slug }}
              className="inline-flex min-h-11 items-center hover:underline"
            >
              <bdi>{p.display_name}</bdi>
            </Link>
          </h3>
          <p className="text-sm font-medium">{from ? priceFromLabel(from) : "Ask for a quote"}</p>
        </div>
      </div>
      <p className="flex min-w-0 items-start gap-1.5 text-sm text-muted-foreground">
        <MapPin className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">{coverageLabel(p)}</span>
      </p>
      {p.bio ? <p className="line-clamp-3 text-sm break-words">{p.bio}</p> : null}
      <div className="mt-auto flex flex-wrap gap-2">
        <Button asChild size="sm" className="min-h-11">
          <Link to="/pros/$slug/quote" params={{ slug: p.slug }} search={{ line }}>
            Request a quote
          </Link>
        </Button>
        <Button
          type="button"
          size="sm"
          variant={picked ? "secondary" : "outline"}
          className="min-h-11 gap-1.5"
          onClick={onToggle}
          disabled={!picked && full}
          aria-pressed={picked}
        >
          {picked ? (
            <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          {picked ? "Comparing" : "Compare"}
        </Button>
      </div>
    </li>
  );
}
