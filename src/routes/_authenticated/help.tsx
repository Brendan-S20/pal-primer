import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BookOpen, Search } from "lucide-react";
import { HELP_ARTICLES, HELP_SECTIONS, getArticle } from "@/lib/help-content";
import { restartTour } from "@/components/OnboardingTour";
import { APP_NAME } from "@/lib/scoop";

// Feature 3: the Knowledge Center. Sections mirror the Settings groupings so
// the taxonomy is one users already recognize; most traffic should arrive via
// contextual HelpTip "?" links rather than browsing here.
export const Route = createFileRoute("/_authenticated/help")({
  validateSearch: (s: Record<string, unknown>) => ({
    article: typeof s.article === "string" ? s.article : undefined,
  }),
  component: HelpPage,
});

function HelpPage() {
  const { article: activeSlug } = Route.useSearch();
  const [q, setQ] = useState("");
  const active = getArticle(activeSlug);

  const grouped = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matches = HELP_ARTICLES.filter(
      (a) =>
        !needle ||
        a.title.toLowerCase().includes(needle) ||
        a.body.some((p) => p.toLowerCase().includes(needle)),
    );
    return HELP_SECTIONS.map((s) => ({
      section: s,
      articles: matches.filter((a) => a.section === s),
    })).filter((g) => g.articles.length > 0);
  }, [q]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <BookOpen className="h-6 w-6" /> Knowledge Center
        </h1>
        <p className="text-sm text-muted-foreground">
          Short, plain-language explanations of everything in {APP_NAME}.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-[260px_1fr]">
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search articles…"
              className="pl-8"
            />
          </div>
          <nav className="space-y-4">
            {grouped.map((g) => (
              <div key={g.section}>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {g.section}
                </div>
                <ul className="space-y-0.5">
                  {g.articles.map((a) => (
                    <li key={a.slug}>
                      <Link
                        to="/help"
                        search={{ article: a.slug }}
                        className={`block rounded-md px-2 py-1 text-sm transition-colors ${
                          a.slug === active?.slug
                            ? "bg-accent font-medium text-accent-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {a.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {!grouped.length && (
              <p className="text-sm text-muted-foreground">Nothing matches that search.</p>
            )}
          </nav>
          <div className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">New here, or new teammates joining?</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 w-full"
              onClick={() => restartTour()}
            >
              Show me the tour again
            </Button>
          </div>
        </div>

        <div>
          {active ? (
            <article className="rounded-lg border bg-card p-6">
              <div className="mb-1 flex items-center gap-2">
                <Badge variant="secondary">{active.section}</Badge>
                {active.audience && <Badge variant="outline">{active.audience}</Badge>}
              </div>
              <h2 className="text-xl font-semibold">{active.title}</h2>
              <div className="mt-3 space-y-3 text-sm leading-relaxed">
                {active.body.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </article>
          ) : (
            <div className="rounded-lg border border-dashed bg-card p-10 text-center text-sm text-muted-foreground">
              Pick an article on the left — or look for the{" "}
              <span className="inline-flex translate-y-0.5 items-center">
                <BookOpen className="h-4 w-4" />
              </span>{" "}
              and "?" icons around the app for help exactly where you need it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
