// "Delete my account", from inside the app.
//
// App Review guideline 5.1.1(v): an app that supports account CREATION must
// let a person delete their account from within the app. This one does support
// creation — an unrecognised email at sign-in walks into /get-started, and that
// chunk ships in the binary — and until this landed the app's only answer was
// the sentence the guideline exists to reject: "email support@houndstack.com".
//
// ── WHY THE COPY SAYS WHAT IT SAYS ────────────────────────────────────────
//
// Two true things have to be said at once, and most products say only the
// flattering one:
//
//   * your sign-in and access are gone — which is what a person means
//   * invoices, payments, service history and audit logs are retained where
//     required — which is what actually happens, and is the law for the
//     business records of a company that took money
//
// Claiming everything vanishes would be a lie a reviewer can check, and a
// person who later disputes an invoice would find it still exists. So the card
// states both, in plain words, before the button rather than after it.
//
// ── THE SOLE OWNER ────────────────────────────────────────────────────────
//
// A workspace with no owner cannot be administered, billed or recovered by
// anybody. So a sole owner is not refused and left there — they are given the
// two real choices, and the picker only appears for them. Everybody else sees
// one sentence and one button, because for them there is nothing to decide.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  deleteMyAccount,
  listOwnershipTransferCandidates,
  type DeletionStep,
} from "@/lib/delete-account.functions";

/**
 * What each unfinished step means TO THE PERSON, not to the log.
 *
 * "Anonymisation failed" is a sentence for us. What they need to know is that
 * an address they thought was detached is still attached, and what it lets
 * somebody do. A `Record` keyed on DeletionStep rather than a switch, so adding
 * a fourth step fails to compile until it has words.
 */
const DELETION_STEP_NOTE: Record<DeletionStep, string> = {
  identity:
    "Your email address is still attached to the sign-in. Until we detach it, a password reset could still be sent to it, and you cannot sign up again with that address.",
  sessions:
    "Devices that were already signed in may still be signed in. If you are deleting because a device was lost or stolen, tell us that when you contact us so we can revoke them first.",
  billing:
    "The workspace subscription was not canceled, so billing may continue. Nothing further will be charged once we cancel it, and anything taken in the meantime is refundable.",
  avatar:
    "Your profile photo could not be removed. Email support@houndstack.com and we will remove it.",
};

export function DeleteAccountCard() {
  const listFn = useServerFn(listOwnershipTransferCandidates);
  const delFn = useServerFn(deleteMyAccount);

  const q = useQuery({
    queryKey: ["ownership-transfer-candidates"],
    queryFn: () => listFn(),
    staleTime: 60_000,
  });

  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [choice, setChoice] = useState<string>("");

  const soleOwner = !!q.data?.soleOwner;
  const candidates = q.data?.candidates ?? [];

  // Non-null once the deletion finished with something outstanding. Holds the
  // card on screen instead of redirecting; see onSuccess.
  const [incomplete, setIncomplete] = useState<DeletionStep[] | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      delFn({
        data: choice === "close" ? { closeWorkspace: true } : choice ? { transferTo: choice } : {},
      }),
    onSuccess: (r: any) => {
      const left = (r?.incomplete ?? []) as DeletionStep[];
      if (left.length) {
        // NO REDIRECT ON THIS PATH, and that is the whole point rather than a
        // detail. The jump to /auth below exists BECAUSE every session was
        // revoked; when the revoke is one of the steps that failed, its premise
        // is false and the person is still signed in. Navigating anyway would
        // also throw away the only telling they get: a toast fired immediately
        // before window.location.href is a toast nobody reads.
        //
        // So the card stays on screen and says what is outstanding, and they
        // leave when they have read it.
        setIncomplete(left);
        return;
      }
      toast.success(
        r?.workspaceClosed
          ? "Your account is deleted and the workspace is closed."
          : "Your account is deleted.",
      );
      // Every session is revoked server-side; go somewhere that does not
      // assume one.
      window.location.href = "/auth";
    },
    // The server's refusals are written to be read by the person who triggered
    // them — the sole-owner message names both ways forward — so they are shown
    // verbatim rather than replaced with something vaguer.
    onError: (e: Error) => toast.error(e.message),
  });

  // Typing the word is the friction. A destructive, irreversible action
  // reachable by one tap on a phone in a pocket is a different risk from the
  // same button on a desktop.
  const armed = confirm.trim().toUpperCase() === "DELETE" && (!soleOwner || !!choice);

  return (
    <Card className="border-destructive/40">
      <CardHeader className="pb-3">
        <CardTitle className="text-base text-destructive">Delete your account</CardTitle>
        <CardDescription>
          Deleting your account removes your sign-in and access. Business records such as invoices,
          payments, service history, and audit logs may be retained where required.
          {soleOwner &&
            " You are the only owner of this workspace, so transfer ownership or close the workspace first."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {incomplete ? (
          <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
            <p className="text-sm font-medium">
              Your records are deleted.{" "}
              {incomplete.length === 1
                ? "One thing is not done."
                : `${incomplete.length} things are not done.`}
            </p>
            <p className="text-sm text-muted-foreground">
              The deletion itself went through and is not reversible. What follows are the steps
              after it that did not complete, and they need us to finish them.
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {incomplete.map((step) => (
                <li key={step}>{DELETION_STEP_NOTE[step]}</li>
              ))}
            </ul>
            <p className="text-sm">
              Please contact us with the date and time so we can finish it. Do not press delete
              again: your records are already gone and it will not clear these.
            </p>
          </div>
        ) : !open ? (
          <Button
            variant="outline"
            className="border-destructive/50 text-destructive"
            onClick={() => setOpen(true)}
          >
            <Trash2 className="mr-2 h-4 w-4 shrink-0" />
            Delete my account
          </Button>
        ) : (
          <div className="space-y-3">
            {soleOwner && (
              <div>
                <Label className="text-xs">What should happen to this workspace?</Label>
                <Select value={choice} onValueChange={setChoice}>
                  <SelectTrigger className="mt-1 w-full sm:w-96">
                    <SelectValue placeholder="Choose one" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((c: any) => (
                      <SelectItem key={c.userId} value={c.userId}>
                        Transfer ownership to {c.name}
                      </SelectItem>
                    ))}
                    <SelectItem value="close">Close the workspace for everyone</SelectItem>
                  </SelectContent>
                </Select>
                {candidates.length === 0 && (
                  <p className="pt-1.5 text-xs text-muted-foreground">
                    Nobody else is on this workspace, so closing it is the only option.
                  </p>
                )}
                {choice === "close" && (
                  <p className="pt-1.5 text-xs text-muted-foreground">
                    Closing stops future billing and ends everyone's access. Invoices, payments and
                    service history are kept.
                  </p>
                )}
              </div>
            )}

            <div>
              <Label htmlFor="del-confirm" className="text-xs">
                Type DELETE to confirm
              </Label>
              <Input
                id="del-confirm"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="DELETE"
                className="mt-1 w-full sm:w-56"
                autoComplete="off"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                disabled={!armed || mut.isPending}
                onClick={() => mut.mutate()}
              >
                {mut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin shrink-0" />}
                Delete my account
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  setConfirm("");
                  setChoice("");
                }}
                disabled={mut.isPending}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
