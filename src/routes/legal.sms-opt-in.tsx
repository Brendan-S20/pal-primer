import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PublicShell } from "@/components/PublicShell";
import { SmsOptInFields, SmsOptInHeading } from "@/components/SmsOptInFields";
import { pageTitle } from "@/lib/page-title";

// #451: a public, read-only copy of the last signup step, so a carrier reviewer
// can land directly on the opt-in without filling in steps 1 and 2. It renders
// the same SmsOptInFields component and consent string as /get-started.
//
// Read-only on purpose: there is no form, no server function and no Supabase
// call here. The box ticks and unticks in local state only. Nothing is stored.
// Not /sms-opt-in, which public/sms-opt-in/ already serves the evidence PNGs from.
export const Route = createFileRoute("/legal/sms-opt-in")({
  head: () => ({
    meta: [
      { title: pageTitle("SMS opt-in step") },
      {
        name: "description",
        content: "The SMS opt-in step shown at the end of signup, for review.",
      },
    ],
  }),
  component: SmsOptInPreviewPage,
});

function SmsOptInPreviewPage() {
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);

  return (
    <PublicShell>
      <p className="text-sm text-muted-foreground">
        This is the exact opt-in step shown at the end of signup at{" "}
        <a href="/get-started" className="underline">
          /get-started
        </a>
        . Enter a number to tick the box, as on the live step. Nothing on this page is saved or
        submitted.
      </p>
      <div className="rounded-xl border bg-card p-(--card-pad) shadow-sm">
        <div className="space-y-4">
          <SmsOptInHeading />
          <SmsOptInFields
            phone={phone}
            onPhoneChange={setPhone}
            smsConsent={smsConsent}
            onSmsConsentChange={setSmsConsent}
          />
          <Button asChild className="w-full">
            <a href="/get-started">Start signup at /get-started</a>
          </Button>
        </div>
      </div>
    </PublicShell>
  );
}
