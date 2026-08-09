/**
 * Your account.
 *
 * There was no such page. Your name was whatever the person who invited you
 * typed into Users & roles, and only an admin could change it — from a table
 * of the whole company. Your email was fixed at signup with no path to change
 * it at all. There was no photo anywhere in the product.
 *
 * Four blocks, in the order the questions actually arrive: who am I, how do
 * you reach me, how do I sign in, what am I allowed to do.
 *
 * The last one is read-only on purpose. Your role and whether you run routes
 * are decisions your employer makes about you, not settings you hold; showing
 * them here as editable would be offering something the server would refuse.
 * They are shown rather than hidden because "why can't I see Billing" is a
 * question this page should be able to answer.
 */
import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Camera, KeyRound, Loader2, Mail, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { UserAvatar } from "@/components/UserAvatar";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { useMyProfile } from "@/hooks/useMyProfile";
import { supabase } from "@/integrations/supabase/client";
import { appOrigin } from "@/lib/app-origin";
import { humanizeRole } from "@/lib/humanize";
import {
  changeMyEmail,
  sendMyPasswordReset,
  setMyAvatar,
  updateMyProfile,
} from "@/lib/profile.functions";

export const Route = createFileRoute("/_authenticated/profile")({
  component: ProfilePage,
});

// Only what a browser will reliably paint in an <img>. HEIC off a recent
// iPhone decodes inconsistently, and a silently broken avatar is worse than
// being told up front that the file will not work.
const ACCEPT = "image/png,image/jpeg,image/webp";
const MAX_BYTES = 8 * 1024 * 1024;

function ProfilePage() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const { staff, authEmail, pendingEmail, loading } = useMyProfile();

  const saveFn = useServerFn(updateMyProfile);
  const avatarFn = useServerFn(setMyAvatar);
  const emailFn = useServerFn(changeMyEmail);
  const resetFn = useServerFn(sendMyPasswordReset);

  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  // Seeded once the query lands. Not a `key` remount: retyping somebody's
  // half-finished edit away because a background refetch returned is the kind
  // of thing that makes a form feel haunted.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !staff) return;
    seeded.current = true;
    setName(staff.display_name ?? "");
    setPhone(staff.phone ?? "");
    setEmail(authEmail ?? staff.email ?? "");
  }, [staff, authEmail]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["my-profile"] });
    // The sidebar, the crew board and Users & roles all render this person.
    qc.invalidateQueries({ queryKey: ["staff"] });
  };

  const save = useMutation({
    mutationFn: () => saveFn({ data: { displayName: name.trim(), phone } }),
    onSuccess: () => {
      toast.success("Profile saved");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!staff) throw new Error("Still loading your account. Try again in a second.");
      if (file.size > MAX_BYTES) throw new Error("That image is larger than 8 MB.");
      const { compressImage } = await import("@/lib/offline/compressImage");
      const { file: compressed, contentType, ext } = await compressImage(file);
      // org/user/timestamp — the first two segments are what the storage
      // policy checks. See migration 20260805120000.
      const path = `${staff.organization_id}/${staff.user_id}/${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from("avatars")
        .upload(path, compressed, { contentType, upsert: false });
      if (error) throw new Error(`Upload failed: ${error.message}`);
      return avatarFn({ data: { path } });
    },
    onSuccess: () => {
      toast.success("Photo updated");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => {
      if (fileRef.current) fileRef.current.value = "";
    },
  });

  const removePhoto = useMutation({
    mutationFn: () => avatarFn({ data: { path: null } }),
    onSuccess: () => {
      toast.success("Photo removed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const changeEmail = useMutation({
    mutationFn: () => emailFn({ data: { email: email.trim() } }),
    onSuccess: (r) => {
      // Deliberately not "email changed" — nothing has changed yet.
      toast.success(`Confirmation sent to ${r.sentTo}. The change takes effect once you click it.`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resetPassword = useMutation({
    mutationFn: () => resetFn({ data: { redirectTo: `${appOrigin()}/auth` } }),
    onSuccess: (r) => toast.success(`Password reset link sent to ${r.sentTo}.`),
    onError: (e: Error) => toast.error(e.message),
  });

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your account…
      </div>
    );
  }

  if (!staff) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No staff record</CardTitle>
          <CardDescription>
            This sign-in is not attached to a company yet, so there is no profile to show. If you
            were invited, open the invitation link again.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const emailChanged = email.trim().toLowerCase() !== (authEmail ?? "").toLowerCase();
  const detailsChanged =
    name.trim() !== (staff.display_name ?? "") || phone.trim() !== (staff.phone ?? "");

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 pb-10">
      {dialog}

      <div>
        <h1 className="text-2xl font-semibold">Your account</h1>
        <p className="text-sm text-muted-foreground">
          How you appear to the rest of your team, and how you sign in.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Photo</CardTitle>
          <CardDescription>
            Shown on the schedule, the crew board and in messages. PNG, JPEG or WebP.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4">
          <UserAvatar
            name={staff.display_name}
            avatarPath={staff.avatar_url}
            seed={staff.id}
            className="h-16 w-16"
            textClassName="text-lg"
          />
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload.mutate(f);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={upload.isPending}
            >
              <Camera className="mr-1.5 h-4 w-4" />
              {upload.isPending ? "Uploading…" : staff.avatar_url ? "Replace" : "Upload"}
            </Button>
            {staff.avatar_url && (
              <Button
                variant="ghost"
                size="sm"
                disabled={removePhoto.isPending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: "Remove your photo?",
                      description: "Your initials will be shown instead.",
                      confirmLabel: "Remove photo",
                    })
                  )
                    removePhoto.mutate();
                }}
              >
                <Trash2 className="mr-1.5 h-4 w-4" />
                Remove
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Details</CardTitle>
          <CardDescription>Your name is what your team sees on every schedule.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pf-name">Name</Label>
              <Input
                id="pf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-phone">Phone</Label>
              <Input
                id="pf-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => save.mutate()}
            disabled={!name.trim() || !detailsChanged || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Sign-in</CardTitle>
          <CardDescription>
            Changing your email sends a confirmation link to the new address. You keep signing in
            with the old one until you click it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {pendingEmail && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
              A change to <strong>{pendingEmail}</strong> is waiting on the confirmation link sent
              to that address.
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="pf-email">Email</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="pf-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-w-[14rem] flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => changeEmail.mutate()}
                disabled={!emailChanged || !email.trim() || changeEmail.isPending}
              >
                <Mail className="mr-1.5 h-4 w-4" />
                {changeEmail.isPending ? "Sending…" : "Send confirmation"}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => resetPassword.mutate()}
              disabled={resetPassword.isPending}
            >
              <KeyRound className="mr-1.5 h-4 w-4" />
              {resetPassword.isPending ? "Sending…" : "Send password reset"}
            </Button>
            <span className="text-xs text-muted-foreground">
              We email you a link rather than asking for a new password here — that way a screen
              somebody left unlocked cannot be used to change it.
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Access</CardTitle>
          <CardDescription>
            Set by an owner or office manager under Settings → Users &amp; roles. Shown here so you
            can see what you have.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          {/* This page told you your role from its own private copy of the
              label map, and Settings → Users & roles — the page the card above
              sends you to — told you from another. Two spellings of one job
              title is a small thing until they disagree, which is what four
              hand-maintained copies of the same four strings eventually do.
              humanizeRole is the single map; the raw-enum fallback it carries
              is better than the one here was, which printed "office_manager". */}
          <Badge variant="secondary">{humanizeRole(staff.role)}</Badge>
          {staff.is_field_tech ? (
            <Badge variant="outline">Runs routes</Badge>
          ) : (
            <span className="text-xs text-muted-foreground">Not assigned to routes</span>
          )}
          {!staff.active && <Badge variant="destructive">Deactivated</Badge>}
        </CardContent>
      </Card>
    </div>
  );
}
