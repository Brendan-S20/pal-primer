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
import { deleteMyAccount, listOwnershipTransferCandidates } from "@/lib/delete-account.functions";

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

  const mut = useMutation({
    mutationFn: () =>
      delFn({
        data: choice === "close" ? { closeWorkspace: true } : choice ? { transferTo: choice } : {},
      }),
    onSuccess: (r: any) => {
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
        {!open ? (
          <Button
            variant="outline"
            className="border-destructive/50 text-destructive"
            onClick={() => setOpen(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
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
                {mut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
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
