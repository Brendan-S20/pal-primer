import { createFileRoute, Link, notFound } from "@tanstack/react-router";
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
  DIRECTORY_NAME,
  directoryHead,
  directoryLineLabel,
  type DirectoryProfile,
} from "@/lib/directory";
import { appOrigin } from "@/lib/app-origin";
import { pageTitle } from "@/lib/page-title";

// One business's directory profile (#630, phase 1). Server-rendered, so the
// HTML carries the profile text. Only what the owner confirmed at opt-in:
// name, logo if they chose to show it, bio, services with price-from, and the
// ZIPs and cities they cover. No address, phone or email: the way to reach the
// business is the quote form, which lands in their /leads.
//
// noindex + self-canonical (directoryHead), whatever the root says. No
// structured data and no stars: reviews are phase 2, and stars wait for 3+
// published reviews even then.

export const Route = createFileRoute("/pros/$slug/")({
  loader: async ({ params }) => {
    let profile: DirectoryProfile | null;
    try {
      const r = await getDirectoryProfiles({ data: { slugs: [params.slug] } });
      profile = r.profiles[0] ?? null;
    } catch {
      return { profile: null as DirectoryProfile | null, failed: true };
    }
    if (!profile) throw notFound();
    return { profile, failed: false };
  },
  head: ({ loaderData, params }) => {
    const name = loaderData?.profile?.display_name;
    return directoryHead({
      title: pageTitle(name, DIRECTORY_NAME),
      description: name
        ? `${name}: services, prices from, and the area they cover. Ask for a quote through HoundStack.`
        : "A pet service business listed in HoundStack's directory.",
      path: `/pros/${encodeURIComponent(params.slug)}`,
      origin: appOrigin(),
    });
  },
  component: DirectoryProfilePage,
  notFoundComponent: ProfileNotListed,
});

function DirectoryProfilePage() {
  const { slug } = Route.useParams();
  const loaded = Route.useLoaderData();
  const fetchProfiles = useServerFn(getDirectoryProfiles);
  const q = useQuery({
    queryKey: ["directory-profile", slug],
    queryFn: () => fetchProfiles({ data: { slugs: [slug] } }).then((r) => r.profiles[0] ?? null),
    initialData: loaded.profile ?? undefined,
    staleTime: 60_000,
    retry: false,
  });

  if (q.isLoading) {
    return (
      <DirectoryShell>
        <p className="text-muted-foreground" role="status">
          Loading…
        </p>
      </DirectoryShell>
    );
  }
  if (!q.data) return <ProfileNotListed />;
  const p = q.data;

  return (
    <DirectoryShell>
      <article className="space-y-8" data-directory-profile>
        <BackToSearch />
        <header className="flex min-w-0 flex-wrap items-start gap-4">
          {p.logo_url ? (
            <img
              src={p.logo_url}
              alt=""
              className="h-16 w-16 shrink-0 rounded-lg border object-contain"
            />
          ) : null}
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight break-words">
              <bdi>{p.display_name}</bdi>
            </h1>
            <p className="text-sm text-muted-foreground">
              {p.service_lines.map(directoryLineLabel).join(" · ")}
            </p>
          </div>
          <Button asChild className="min-h-11 w-full sm:w-auto">
            <Link to="/pros/$slug/quote" params={{ slug: p.slug }} search={{}}>
              Request a quote
            </Link>
          </Button>
        </header>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-6">
            {p.bio ? (
              <section className="space-y-2">
                <h2 className="text-lg font-semibold">About</h2>
                <p className="whitespace-pre-line break-words">
                  <bdi>{p.bio}</bdi>
                </p>
              </section>
            ) : null}
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">Services and prices from</h2>
              <DirectoryServiceList profile={p} />
              <p className="text-xs text-muted-foreground">
                Prices are a starting point the business confirmed. Your quote comes from the
                business.
              </p>
            </section>
          </div>
          <aside className="min-w-0 space-y-2">
            <h2 className="text-lg font-semibold">Where they work</h2>
            <DirectoryCoverage profile={p} />
          </aside>
        </div>
      </article>
    </DirectoryShell>
  );
}

function BackToSearch() {
  return (
    <Link
      to="/pros"
      className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ChevronLeft className="h-4 w-4 shrink-0 rtl:rotate-180" aria-hidden="true" />
      Back to search
    </Link>
  );
}

function ProfileNotListed() {
  return (
    <DirectoryShell>
      <div className="space-y-3 py-12 text-center">
        <h1 className="text-2xl font-semibold">This business isn't listed</h1>
        <p className="text-muted-foreground">
          It may have left the directory, or the link may be wrong.
        </p>
        <Button asChild variant="outline" className="min-h-11">
          <Link to="/pros">Search the directory</Link>
        </Button>
      </div>
    </DirectoryShell>
  );
}
