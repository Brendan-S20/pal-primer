// Mini design system primitives (QA follow-up Stage 3). One chip component
// with two jobs kept separate (colored = status, neutral outline = metadata),
// one empty-state template, and a consistent section label. Every tab
// inherits these instead of hand-rolling badges and gray paragraphs.
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// ── Chips ───────────────────────────────────────────────────────────────────

const STATUS_TONES: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  paid: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  enabled: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  scheduled: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  open: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  in_progress: "bg-amber-500/15 text-amber-800 dark:text-amber-400",
  paused: "bg-amber-500/15 text-amber-800 dark:text-amber-400",
  warning: "bg-amber-500/15 text-amber-800 dark:text-amber-400",
  overdue: "bg-destructive/10 text-destructive",
  canceled: "bg-destructive/10 text-destructive",
  failed: "bg-destructive/10 text-destructive",
  missed: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  ended: "bg-muted text-muted-foreground",
  skipped: "bg-muted text-muted-foreground",
  inactive: "bg-muted text-muted-foreground",
  void: "bg-muted text-muted-foreground",
};

function sentenceCase(s: string): string {
  const words = s.replace(/[_-]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** Colored chip for STATE (active, paused, overdue…). Sentence case. */
export function StatusChip({
  status,
  label,
  className,
}: {
  status: string;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        STATUS_TONES[status] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      {label ?? sentenceCase(status)}
    </span>
  );
}

/** Neutral outline chip for METADATA (postpaid, Residential, Auto-calculated…). */
export function MetaChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs text-foreground/70",
        className,
      )}
    >
      {children}
    </span>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────

/** One template everywhere: icon + one-line explanation + optional action. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  compact = false,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed text-center",
        compact ? "gap-1 p-4" : "gap-2 p-8",
      )}
    >
      <Icon className={cn("text-muted-foreground/60", compact ? "h-5 w-5" : "h-7 w-7")} />
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-sm text-xs text-foreground/60">{description}</p>}
      {actionLabel && onAction && (
        <Button type="button" size="sm" variant="outline" className="mt-1" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

// ── Section label ───────────────────────────────────────────────────────────

/** 12px minimum, dark enough for AA — replaces the 10px light-gray all-caps. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "text-xs font-semibold uppercase tracking-wide text-foreground/70",
        className,
      )}
    >
      {children}
    </div>
  );
}
