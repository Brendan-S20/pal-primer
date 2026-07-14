import { Link } from "@tanstack/react-router";
import { HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getArticle } from "@/lib/help-content";

/**
 * Contextual "?" next to jargon-heavy labels (Zones, Skip rules, Blackouts,
 * DNA, Royalties, churn score…). Hover shows the first line of the article;
 * click lands on the full article in the Knowledge Center. Keep these on the
 * labels persona testing flagged — a "?" on everything helps nothing.
 */
export function HelpTip({ article, label }: { article: string; label?: string }) {
  const a = getArticle(article);
  if (!a) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/help"
          search={{ article }}
          aria-label={label ?? `Learn more: ${a.title}`}
          className="inline-flex align-middle text-muted-foreground transition-colors hover:text-foreground"
        >
          <HelpCircle className="h-4 w-4" />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        {/* Article text carries inline [label](target) links + **bold**;
            flatten to plain text for the tooltip. */}
        <p className="text-xs">
          {a.body[0].replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*/g, "")}
        </p>
        <p className="mt-1 text-xs font-medium">Click to read more</p>
      </TooltipContent>
    </Tooltip>
  );
}
