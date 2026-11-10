import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronLeft } from "lucide-react";
import { DirectoryShell } from "@/components/directory/DirectoryShell";
import {
  DirectoryCoverage,
  DirectoryServiceList,
} from "@/components/directory/DirectoryProfileParts";
import { Button } from "@/components/ui/button";
import { getDirectoryProfiles } from "@/lib/directory.functions";
import {
  MAX_COMPARE,
  compareSlugs,
  directoryHead,
  directoryLineLabel,
  isDirectorySearchLine,
  lowestPriceFrom,
  priceFromLabel,
  type DirectoryProfile,
  type DirectorySearchLine,
} from "@/lib/directory";
import { DIRECTORY_BRAND, directoryOrigin } from "@/lib/directory-site";
import { pageTitle } from "@/lib/page-title";

// Compare up to three directory profiles side by side (#630, phase 1).
//
// Side by side from md up; on a phone each business is its own card with the
// same sections in the same order, one under another. A three-column table
// does not become usable at 360px by getting smaller (CLAUDE.md: dense grids
// reflow, they do not shrink).
//
// noindex + self-canonical. The canonical is /pros/compare with no query: a
// comparison is a visitor's own selection, not a page of its own.

type Search = { slugs?: string; line?: DirectorySearchLine };

export const Route = createFileRoute("/pros/compare")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    slugs: typeof s.slugs === "string" ? compareSlugs(s.slugs).join(",") || undefined : undefined,
    line: isDirectorySearchLine(s.line) ? s.line : undefined,
  }),
  loaderDeps: ({ search }) => ({ slugs: search.slugs }),
  loader: async ({ deps }) => {
    const slugs = compareSlugs(deps.slugs);
    if (!slugs.length) return { profiles: [] as DirectoryProfile[] | null };
    try {
      const r = await getDirectoryProfiles({ data: { slugs } });
      return { profiles: r.profiles as DirectoryProfile[] | null };
    } catch {
      return { profiles: null as DirectoryProfile[] | null };
    }
  },
  head: () =>
    directoryHead({
      title: pageTitle("Compare", DIRECTORY_BRAND),
      description: `Compare up to ${MAX_COMPARE} pet service businesses side by side.`,
      path: "/pros/compare",
      origin: directoryOrigin(),
    }),
  component: ComparePage,
});

function ComparePage() {
  const search = Route.useSearch();
  const slugs = compareSlugs(search.slugs);
  const { profiles: loaded } = Route.useLoaderData();
  const fetchProfiles = useServerFn(getDirectoryProfiles);
  const q = useQuery({
    queryKey: ["directory-compare", slugs.join(",")],
    queryFn: () => fetchProfiles({ data: { slugs } }).then((r) => r.profiles),
    enabled: slugs.length > 0,
    initialData: loaded ?? undefined,
    staleTime: 60_000,
    retry: false,
  });
  const profiles = q.data ?? [];

  return (
    <DirectoryShell>
      <div className="space-y-6">
        <Link
          to="/pros"
          search={{ line: search.line }}
          className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4 shrink-0 rtl:rotate-180" aria-hidden="true" />
          Back to search
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">Compare</h1>

        {q.isLoading ? (
          <p className="text-muted-foreground" role="status">
            Loading…
          </p>
        ) : profiles.length === 0 ? (
          <div className="rounded-lg border p-6 text-center">
            <p className="font-medium">Nothing to compare yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Search the directory and tick up to {MAX_COMPARE} businesses.
            </p>
          </div>
        ) : (
          <ul
            className={
              profiles.length === 1
                ? "grid gap-4"
                : profiles.length === 2
                  ? "grid gap-4 md:grid-cols-2"
                  : "grid gap-4 md:grid-cols-3"
            }
            data-directory-compare-grid
          >
            {profiles.map((p) => (
              <CompareCard key={p.slug} profile={p} line={search.line ?? null} />
            ))}
          </ul>
        )}
      </div>
    </DirectoryShell>
  );
}

function CompareCard({
  profile: p,
  line,
}: {
  profile: DirectoryProfile;
  line: DirectorySearchLine | null;
}) {
  const from = lowestPriceFrom(p, line);
  return (
    <li className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex min-w-0 items-start gap-3">
        {p.logo_url ? (
          <img
            src={p.logo_url}
            alt=""
            className="h-12 w-12 shrink-0 rounded-md border object-contain"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold break-words">
            <Link
              to="/pros/$slug"
              params={{ slug: p.slug }}
              className="inline-flex min-h-11 items-center hover:underline"
            >
              <bdi>{p.display_name}</bdi>
            </Link>
          </h2>
        </div>
      </div>
      <dl className="grid gap-3 text-sm">
        <div>
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {line ? directoryLineLabel(line) : "Lowest price"}
          </dt>
          <dd className="font-medium">{from ? priceFromLabel(from) : "Ask for a quote"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Services
          </dt>
          <dd>{p.service_lines.map(directoryLineLabel).join(", ")}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Area
          </dt>
          <dd>
            <DirectoryCoverage profile={p} />
          </dd>
        </div>
      </dl>
      <DirectoryServiceList profile={p} />
      <Button asChild className="mt-auto min-h-11">
        <Link to="/pros/$slug/quote" params={{ slug: p.slug }} search={{ line: line ?? undefined }}>
          Request a quote
        </Link>
      </Button>
    </li>
  );
}
