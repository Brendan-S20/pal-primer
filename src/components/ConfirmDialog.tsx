// Styled replacement for window.confirm (QA follow-up 1.4: native dialogs
// block the renderer and froze automated testing). Promise-based so call
// sites read like confirm():
//
//   const { confirm, dialog } = useConfirmDialog();
//   ...
//   if (await confirm({ title: "Delete note?", destructive: true })) ...
//   ...
//   return <>{dialog}...</>
import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ConfirmOptions {
  title: string;
  /** One or more explanatory lines / dependency lists. */
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for destructive actions. */
  destructive?: boolean;
}

export function useConfirmDialog() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<(v: boolean) => void>(() => {});

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOptions(opts);
    });
  }, []);

  function settle(value: boolean) {
    resolver.current(value);
    resolver.current = () => {};
    setOptions(null);
  }

  const dialog = (
    <AlertDialog open={!!options} onOpenChange={(o) => !o && settle(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{options?.title}</AlertDialogTitle>
          {options?.description ? (
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">{options.description}</div>
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            {options?.cancelLabel ?? "Cancel"}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => settle(true)}
            className={
              options?.destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
          >
            {options?.confirmLabel ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirm, dialog };
}
