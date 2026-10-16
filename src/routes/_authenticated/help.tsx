import { launchCopy, useLaunchCopy } from "@/lib/launch-copy";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight, BookOpen, ExternalLink, Search } from "lucide-react";
import { HELP_ARTICLES, HELP_SECTIONS, getArticle } from "@/lib/help-content";
import { helpMatchScore } from "@/lib/help-search";
import { SetupGuideCard } from "@/components/SetupGuideCard";
import { APP_NAME } from "@/lib/scoop";
import { titleHead } from "@/lib/page-title";

// The Knowledge Center. Sections mirror the Settings groupings so the
// taxonomy is one users already recognize. Articles cross-link each other
// ([label](article:slug)) and deep-link into the app ([label](/path)), so
// help lands you on the page it's describing.
export const Route = createFileRoute("/_authenticated/help")({
  head: () => titleHead("Knowledge Center"),
  validateSearch: (s: Record<string, unknown>) => ({
    article: typeof s.article === "string" ? s.article : undefined,
  }),
  component: HelpPage,
});

// Inline renderer for article text: [label](article:slug) links to another
// article, [label](/path) links into the app, **bold** is bold.
function renderInline(text: string): ReactNode[] {
  text = launchCopy(text);
  const parts: ReactNode[] = [];
  const regex = /(\[[^\]]+\]\((?:article:[\w-]+|\/[^)]*)\)|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      const m = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      const label = m[1];
      const target = m[2];
      if (target.startsWith("article:")) {
        parts.push(
          <Link
            key={key++}
            to="/help"
            search={{ article: target.slice("article:".length) }}
            className="font-medium text-primary underline underline-offset-2 hover:no-underline"
          >
            {label}
          </Link>,
        );
      } else {
        parts.push(
          <Link
            key={key++}
            to={target as never}
            className="font-medium text-primary underline underline-offset-2 hover:no-underline"
          >
            {label}
          </Link>,
        );
      }
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function HelpPage() {
  const copy = useLaunchCopy();
  const { article: activeSlug } = Route.useSearch();
  const [q, setQ] = useState("");
  const active = getArticle(activeSlug);

  const grouped = useMemo(() => {
    // Word matching with a few synonyms: see src/lib/help-search.ts. Best
    // match first within each section, so the article the words are ABOUT
    // leads the ones that merely mention them.
    const scored = HELP_ARTICLES.map((a) => ({ a, score: helpMatchScore(a, q) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score);
    const matches = scored.map((x) => x.a);
    return HELP_SECTIONS.map((s) => ({
      section: s,
      articles: matches.filter((a) => a.section === s),
    })).filter((g) => g.articles.length > 0);
  }, [q]);

  const related = (active?.related ?? []).map((slug) => getArticle(slug)).filter(Boolean);

  return (
    <>
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <BookOpen className="h-6 w-6 shrink-0" /> Knowledge Center
        </h1>
        <p className="text-sm text-muted-foreground">
          Short, plain-language explanations and walkthroughs for everything in {APP_NAME}.
        </p>
      </div>

      {/* The two columns key on the width of the PAGE COLUMN (`@container`),
          not the window. At 768, a tablet in portrait, the sidebar takes
          256px and the column is 464px: `md:` split that into the 260px list
          and a ~180px "Start here" card, whose own `sm:` grid then cut it into
          two 60px tiles. One word ("completed") was wider than its tile, and
          on the hosted Linux runner's fonts it ran 1.3px past the column.
          Below 42rem the list and the article stack, full width: reflowed
          rather than shrunk. The cards inside "Start here" go two-up on the
          same terms, on the card's own width. */}
      <div className="@container">
        <div className="grid gap-6 @2xl:grid-cols-[260px_1fr]">
          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground shrink-0" />
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
                          {copy(a.title)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {!grouped.length && (
                <p className="text-sm text-muted-foreground">
                  Nothing matches that search. Try fewer words, or one word such as "invoice".
                </p>
              )}
            </nav>
            {/* Was "Show me the tour again", which replayed a spotlight tour
              of the menu. The guide it re-opens now sets the business up,
              so it is offered to the people who can do that. */}
            <SetupGuideCard />
          </div>

          {/* Stacked, the article (or "Start here") comes first: below a list
              of forty-odd titles, picking one changed nothing on screen. */}
          <div className="min-w-0 @max-2xl:order-first">
            {active ? (
              <article className="rounded-lg border bg-card p-(--card-pad)">
                <div className="mb-1 flex items-center gap-2">
                  <Badge variant="secondary">{active.section}</Badge>
                  {active.audience && <Badge variant="outline">{active.audience}</Badge>}
                </div>
                <h2 className="text-xl font-semibold">{copy(active.title)}</h2>
                <div className="mt-3 space-y-3 text-sm leading-relaxed">
                  {active.body.map((p, i) => (
                    <p key={i}>{renderInline(p)}</p>
                  ))}
                </div>

                {active.steps && active.steps.length > 0 && (
                  <div className="mt-5 rounded-lg border bg-muted/30 p-4">
                    <h3 className="text-sm font-semibold">Step-by-step</h3>
                    <ol className="mt-2 space-y-2 text-sm leading-relaxed">
                      {active.steps.map((s, i) => (
                        <li key={i} className="flex gap-3">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                            {i + 1}
                          </span>
                          <span className="pt-0.5">{renderInline(s)}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {active.appLink && (
                  <div className="mt-5">
                    <Link to={active.appLink.to as never}>
                      <Button size="sm">
                        {active.appLink.label}{" "}
                        <ExternalLink className="ml-1 h-3.5 w-3.5 shrink-0" />
                      </Button>
                    </Link>
                  </div>
                )}

                {related.length > 0 && (
                  <div className="mt-6 border-t pt-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Related
                    </h3>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {related.map((r) => (
                        <Link
                          key={r!.slug}
                          to="/help"
                          search={{ article: r!.slug }}
                          className="inline-flex items-center gap-1 rounded-full border bg-background px-3 py-1 text-xs transition-colors hover:bg-muted"
                        >
                          {r!.title} <ArrowRight className="h-3 w-3 shrink-0" />
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            ) : (
              <div className="space-y-4">
                {/* Landing state: pitch the walkthroughs instead of a bare box. */}
                <div className="rounded-lg border bg-card p-(--card-pad)">
                  <h2 className="text-base font-semibold">Start here</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    The guides most people need first:
                  </p>
                  <div className="@container">
                    <div className="mt-3 grid gap-2 @sm:grid-cols-2">
                      {[
                        "first-30-minutes",
                        "import-clients",
                        "routes-planning",
                        "getting-paid",
                      ].map((slug) => {
                        const a = getArticle(slug)!;
                        return (
                          <Link
                            key={slug}
                            to="/help"
                            search={{ article: slug }}
                            className="rounded-lg border p-3 text-sm transition-colors hover:border-primary hover:bg-muted/50"
                          >
                            <span className="font-medium">{copy(a.title)}</span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {a.section}
                              {a.steps ? ` · ${a.steps.length} steps` : ""}
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <p className="text-center text-sm text-muted-foreground">
                  Or pick any article from the list. The{" "}
                  <Fragment>
                    <span className="inline-flex translate-y-0.5 items-center">
                      <BookOpen className="h-4 w-4 shrink-0" />
                    </span>
                  </Fragment>{" "}
                  and "?" icons around the app link straight to the relevant article.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
