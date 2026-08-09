import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getSignupSettings, setSignupSettings } from "@/lib/signup.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { appOrigin } from "@/lib/app-origin";

// Online signup: the settings surface the feature never had.
//
// The whole /signup/{slug} flow — instant quote, inline card form, webhook
// provisioning, welcome email — has been in the product and unreachable, and
// unreachable in a way no owner could have diagnosed. It is gated on TWO
// things, and neither had any UI:
//
//   organizations.public_signup_enabled   boolean, defaults to false
//   the address the link resolves on      slug / portal_slug
//
// The boolean simply had no toggle anywhere. The address was worse:
// `bootstrap_organization` never writes `organizations.slug`, so every tenant
// that has ever signed itself up has NULL there, and the old lookup compared
// `slug = _slug` — NULL = anything is NULL, no row, and /signup/{anything}
// answered "This company isn't taking online signups right now." Forever, with
// no error and nothing to change.
//
// Migration 20260809001000 made the lookup resolve `portal_slug` as well, which
// is the column the product actually maintains, so most tenants now have a
// working signup address the moment they flip the toggle. This page is the
// other half: the toggle itself, the optional signup-specific address, and the
// resulting link shown as a link — because a feature whose URL you have to
// derive by hand is a feature nobody turns on.
//
// Modelled on Settings → Lead form, deliberately: the two are the same job
// (send a stranger to a hosted page that belongs to you) and an owner should
// not have to learn two layouts to do them.
export const Route = createFileRoute("/_authenticated/settings/online-signup")({
  component: OnlineSignupSettings,
});

const APP_ORIGIN = appOrigin();

function OnlineSignupSettings() {
  const qc = useQueryClient();
  const getFn = useServerFn(getSignupSettings);
  const setFn = useServerFn(setSignupSettings);

  const q = useQuery({ queryKey: ["signup-settings"], queryFn: () => getFn() });
  const cfg = q.data;

  const [slug, setSlug] = useState("");
  useEffect(() => {
    setSlug(cfg?.signupSlug ?? "");
  }, [cfg?.signupSlug]);

  const save = useMutation({
    mutationFn: (patch: { publicSignupEnabled?: boolean; signupSlug?: string }) =>
      setFn({ data: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["signup-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // The address the RPC will actually answer on, computed the same way the
  // function resolves it: portal_slug wins, the signup-specific slug is the
  // fallback. Showing anything else here would hand out a link that 404s for
  // exactly the reason this whole page exists.
  const effective = cfg?.portalSlug || (slug.trim() ? slug.trim() : cfg?.signupSlug) || null;
  const publicUrl = effective ? `${APP_ORIGIN}/signup/${effective}` : null;

  const copy = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Couldn't copy"),
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Online signup</h2>
        <p className="text-sm text-muted-foreground">
          Let homeowners price their yard, enter their details and pay their first invoice without
          calling you. New customers arrive already scheduled.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Label htmlFor="public-signup" className="text-sm font-medium">
                  Accept signups online
                </Label>
                <p className="mt-1 text-sm text-muted-foreground">
                  When this is off, your signup link tells visitors you aren't taking online
                  signups. Your lead form keeps working either way — that one is not affected by
                  this switch.
                </p>
              </div>
              <Switch
                id="public-signup"
                checked={!!cfg?.publicSignupEnabled}
                disabled={save.isPending}
                onCheckedChange={(v) => {
                  save.mutate(
                    { publicSignupEnabled: v },
                    {
                      onSuccess: () =>
                        toast.success(v ? "Online signup is on" : "Online signup is off"),
                    },
                  );
                }}
              />
            </div>

            {/* Truthful precondition, not a scare: the toggle is meaningless
                without an address for the link to resolve on, and a tenant with
                neither slug set would otherwise turn this on and hand out a URL
                that answers nothing. */}
            {cfg?.publicSignupEnabled && !effective ? (
              <div className="mt-3 rounded-md border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900">
                Online signup is on, but you have no web address yet, so there's no link to give
                anyone. Set one below (or set your portal address in Settings → Preferences —
                signup will use that).
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-2 text-sm font-medium">Your signup link</h2>
            {publicUrl ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-muted px-2 py-1 text-xs">{publicUrl}</code>
                  <button
                    className="text-xs text-primary underline"
                    onClick={() => copy(publicUrl, "Link")}
                  >
                    Copy link
                  </button>
                  <a
                    className="text-xs text-primary underline"
                    href={publicUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Preview
                  </a>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Put this on your website, in your Google listing, and in your voicemail greeting.
                  It shows your logo and brand colour, not ours.
                  {cfg?.portalSlug && cfg?.signupSlug && cfg.portalSlug !== cfg.signupSlug ? (
                    <>
                      {" "}
                      <span className="text-foreground">
                        /signup/{cfg.signupSlug} works too — both addresses reach you.
                      </span>
                    </>
                  ) : null}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Set a web address below and your link will appear here.
              </p>
            )}
          </div>

          <form
            className="space-y-3 rounded-lg border bg-card p-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(
                { signupSlug: slug.trim() },
                { onSuccess: () => toast.success("Signup address saved") },
              );
            }}
          >
            <h2 className="text-sm font-medium">Signup web address</h2>
            <div className="flex flex-wrap items-center gap-1 text-sm">
              <span className="text-muted-foreground">
                {APP_ORIGIN.replace(/^https?:\/\//, "")}/signup/
              </span>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                className="h-8 w-48"
                placeholder={cfg?.portalSlug ?? "your-company"}
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={save.isPending || slug.trim() === (cfg?.signupSlug ?? "")}
              >
                {save.isPending ? "Saving…" : "Save address"}
              </Button>
            </div>
            {/* Blank is a real answer, and for most tenants it is the right
                one. Since the lookup resolves portal_slug too, a business that
                has already set its portal address has a working signup link
                without touching this field, and having one address instead of
                two is less to explain to a customer. */}
            <p className="text-xs text-muted-foreground">
              Letters, numbers and hyphens only. Leave it empty to use your portal address
              {cfg?.portalSlug ? ` (${cfg.portalSlug})` : ""} — signup accepts either.
            </p>
          </form>
        </>
      )}
    </div>
  );
}
