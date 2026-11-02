import type { ReactNode } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button, type ButtonProps } from "@/components/ui/button";

// One reusable confirmation gate for destructive actions app-wide (QA finding
// #38). Wrap any button-like trigger; the action only fires after the user
// confirms in the dialog, which states plainly what happens and that it can't
// be undone.
export function ConfirmButton({
  trigger,
  title,
  description,
  confirmLabel = "Confirm",
  onConfirm,
  onOpen,
  disabled,
  variant = "destructive",
  size,
  children,
}: {
  trigger?: ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
  /** Called when the dialog opens, e.g. to note the version the person is
   *  looking at before they confirm (#655). */
  onOpen?: () => void;
  disabled?: boolean;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  children?: ReactNode;
}) {
  return (
    <AlertDialog onOpenChange={(open) => (open ? onOpen?.() : undefined)}>
      <AlertDialogTrigger asChild>
        {trigger ?? (
          <Button variant={variant} size={size} disabled={disabled}>
            {children}
          </Button>
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
