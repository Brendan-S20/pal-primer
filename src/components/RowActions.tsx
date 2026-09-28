// Salesforce-style row actions cell (owner spec 2026-07): a compact,
// right-aligned trio — View ghost button, Edit ghost button (when an edit
// affordance exists), and a ••• overflow menu for contextual actions.
// Purely presentational: callers pass callbacks that reuse existing
// mutations/navigation. Every click stops propagation so clickable rows
// (drawer-opening invoice/visit rows) never double-fire.
//
// The three buttons are 32px on a pointer and 44px on touch. The compact trio
// is the point of the spec on a desktop table, but 32px is well under the touch
// floor, and these are the controls that open, edit and DELETE a row — a
// mis-hit here is not a cosmetic problem. `max-md:` rather than a change to
// `ui/button.tsx`'s `size="icon"`, which is 20 other call sites and a density
// decision that is not this component's to make.
import { Eye, MoreHorizontal, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type RowAction = {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

export function RowActions({
  view,
  edit,
  actions = [],
}: {
  view?: { label?: string; onSelect: () => void };
  edit?: { label?: string; onSelect: () => void };
  actions?: RowAction[];
}) {
  const normal = actions.filter((a) => !a.destructive);
  const destructive = actions.filter((a) => a.destructive);
  if (!view && !edit && actions.length === 0) return null;

  return (
    <div
      className="flex items-center justify-end gap-0.5"
      onClick={(e) => e.stopPropagation()}
    >
      {view && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground touch:h-11 touch:w-11"
          aria-label={view.label ?? "View"}
          title={view.label ?? "View"}
          onClick={(e) => {
            e.stopPropagation();
            view.onSelect();
          }}
        >
          <Eye className="h-4 w-4 shrink-0" />
        </Button>
      )}
      {edit && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground touch:h-11 touch:w-11"
          aria-label={edit.label ?? "Edit"}
          title={edit.label ?? "Edit"}
          onClick={(e) => {
            e.stopPropagation();
            edit.onSelect();
          }}
        >
          <Pencil className="h-4 w-4 shrink-0" />
        </Button>
      )}
      {actions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground touch:h-11 touch:w-11"
              aria-label="More actions"
              title="More actions"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            {normal.map((a) => (
              <DropdownMenuItem key={a.label} disabled={a.disabled} onSelect={a.onSelect}>
                {a.label}
              </DropdownMenuItem>
            ))}
            {normal.length > 0 && destructive.length > 0 && <DropdownMenuSeparator />}
            {destructive.map((a) => (
              <DropdownMenuItem
                key={a.label}
                disabled={a.disabled}
                className="text-destructive focus:text-destructive"
                onSelect={a.onSelect}
              >
                {a.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
