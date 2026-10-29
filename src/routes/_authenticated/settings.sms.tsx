import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, Clock, Info } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  checkTextingStatusNow,
  getTextingRegistration,
  saveTextingDraft,
  submitTextingRegistration,
} from "@/lib/texting-registration.functions";
import {
  BUSINESS_TYPES,
  canSubmit,
  describeStatus,
  einSchema,
  registrationDetailsSchema,
  type BusinessType,
  type RegistrationStatus,
} from "@/lib/texting-registration";
import { getOrgTwilioSettings } from "@/lib/twilio-settings.functions";
import { useMyRole } from "@/hooks/useMyRole";
import { titleHead } from "@/lib/page-title";
import { formatDateTime, formatDay } from "@/lib/format";

// Settings → Texting (#538, BUILD-3).
//
// One subaccount per business, registered in that business's own name
// (toll-free verification by default). The owner fills in the business's
// details as they appear on its EIN letter and presses Submit; HoundStack
// creates the Twilio subaccount, the business profile, a toll-free number and
// its verification (lib/twilio-provisioning.server). Nobody opens the Twilio
// console. The status below is Twilio's, checked every ten minutes, in plain
// words.
//
// IMP-9 history: this page was once a "Bring your own Twilio" form, then a
// "not yet available" notice while provisioning waited to be built. Nothing
// here asks for a Twilio credential, and the number is never typed in: it is
// issued by Twilio and shown once it is approved.
//
// HoundStack's own toll-free number texts account holders only. It never
// sends to a business's clients, before or after this page is done.

export const Route = createFileRoute("/_authenticated/settings/sms")({
  head: () => titleHead("Texting", "Settings"),
  component: TextingSettings,
});

type Contact = {
  first_name: string;
  last_name: string;
  title: string;
  email: string;
  phone: string;
};
type Form = {
  legal_name: string;
  business_type: BusinessType | "";
  dba: string;
  street: string;
  street2: string;
  city: string;
  region: string;
  postal_code: string;
  website_url: string;
  privacy_url: string;
  terms_url: string;
  business_email: string;
  business_phone: string;
  contacts: [Contact, Contact];
};

const NO_SUGGESTIONS = { businessName: "", email: "", phone: "" };

const emptyContact = (): Contact => ({
  first_name: "",
  last_name: "",
  title: "",
  email: "",
  phone: "",
});

function formFrom(
  reg: Record<string, any> | null,
  s: { businessName: string; email: string; phone: string },
): Form {
  const c = Array.isArray(reg?.contacts) ? reg!.contacts : [];
  const contact = (i: number): Contact => ({ ...emptyContact(), ...(c[i] ?? {}) });
  return {
    legal_name: reg?.legal_name ?? "",
    business_type: (reg?.business_type as BusinessType) ?? "",
    dba: reg?.dba ?? (reg ? "" : s.businessName),
    street: reg?.street ?? "",
    street2: reg?.street2 ?? "",
    city: reg?.city ?? "",
    region: reg?.region ?? "",
    postal_code: reg?.postal_code ?? "",
    website_url: reg?.website_url ?? "",
    privacy_url: reg?.privacy_url ?? "",
    terms_url: reg?.terms_url ?? "",
    business_email: reg?.business_email ?? (reg ? "" : s.email),
    business_phone: reg?.business_phone ?? (reg ? "" : s.phone),
    contacts: [contact(0), contact(1)],
  };
}


function TextingSettings() {
  const qc = useQueryClient();
  const getFn = useServerFn(getTextingRegistration);
  const q = useQuery({
    queryKey: ["texting-registration"],
    queryFn: () => getFn(),
    // While Twilio has it, keep the screen current without a reload.
    refetchInterval: (query) => {
      const s = (query.state.data as any)?.registration?.status as RegistrationStatus | undefined;
      return s === "submitting" || s === "submitted" || s === "in_review" ? 60_000 : false;
    },
  });
  const { role } = useMyRole();

  const reg = q.data?.registration ?? null;
  const status = (reg?.status as RegistrationStatus | undefined) ?? null;
  const summary = describeStatus(reg as any, (iso) => formatDay(iso));

  const checkFn = useServerFn(checkTextingStatusNow);
  const check = useMutation({
    mutationFn: () => checkFn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["texting-registration"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Texting</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your business gets its own toll-free number, registered with carriers in your
          business&apos;s legal name. Reminders, on-my-way notices, invoices and replies to your
          clients go out from it, and only to clients who agreed to texts.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : q.isError ? (
        <p className="text-sm text-destructive">
          Could not load your texting setup. Refresh to try again.
        </p>
      ) : (
        <>
          <StatusCard
            summary={summary}
            checkedAt={reg?.checked_at ?? null}
            canCheck={status === "submitted" || status === "in_review"}
            checking={check.isPending}
            onCheck={() => check.mutate()}
          />
          {q.data?.live && <LiveSender />}
          {canSubmit(status, reg?.updated_at ?? null) ? (
            <RegistrationForm
              key={status ?? "new"}
              initial={formFrom(reg, q.data?.suggestions ?? NO_SUGGESTIONS)}
              status={status}
              isOwner={role === "owner"}
            />
          ) : (
            reg && <FiledDetails reg={reg} />
          )}
          <p className="text-xs text-muted-foreground">
            HoundStack&apos;s own number texts account holders only. It never texts your clients.
          </p>
        </>
      )}
    </div>
  );
}

function StatusCard({
  summary,
  checkedAt,
  canCheck,
  checking,
  onCheck,
}: {
  summary: ReturnType<typeof describeStatus>;
  checkedAt: string | null;
  canCheck: boolean;
  checking: boolean;
  onCheck: () => void;
}) {
  const Icon =
    summary.tone === "good"
      ? CheckCircle2
      : summary.tone === "bad"
        ? AlertTriangle
        : summary.tone === "waiting"
          ? Clock
          : Info;
  const color =
    summary.tone === "good"
      ? "text-emerald-600"
      : summary.tone === "bad"
        ? "text-destructive"
        : summary.tone === "waiting"
          ? "text-amber-600"
          : "text-muted-foreground";
  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 text-sm" data-testid="texting-status">
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
        <div className="min-w-0">
          <div className="font-medium">{summary.title}</div>
          <div className="mt-1 break-words text-xs text-muted-foreground">{summary.detail}</div>
          {checkedAt && canCheck && (
            <div className="mt-1 text-xs text-muted-foreground">
              Last checked {formatDateTime(checkedAt)}. We check again every ten minutes.
            </div>
          )}
        </div>
      </div>
      {canCheck && (
        <Button variant="outline" size="sm" onClick={onCheck} disabled={checking}>
          {checking ? "Checking…" : "Check now"}
        </Button>
      )}
    </div>
  );
}

/** Once texting is live: the number as the credential row has it, which is
 *  what every text to a client is actually sent from. */
function LiveSender() {
  const fn = useServerFn(getOrgTwilioSettings);
  const q = useQuery({ queryKey: ["org-twilio-settings"], queryFn: () => fn() });
  if (!q.data?.configured) return null;
  return (
    <div className="rounded-lg border bg-card p-4 text-sm">
      <div className="font-medium">Your texting number</div>
      <div className="mt-1 font-mono text-base">
        <span dir="ltr">{q.data.smsFromNumber}</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Every text to your clients goes out from this number: messages from your staff, reminders,
        on-my-way notices, review asks and portal sign-in codes. Replies arrive in Messages. Each
        text starts with your business name.
      </p>
    </div>
  );
}

function FiledDetails({ reg }: { reg: Record<string, any> }) {
  const rows: Array<[string, string | null]> = [
    ["Legal name", reg.legal_name],
    ["Doing business as", reg.dba],
    ["EIN", reg.ein_last4 ? `ending in ${reg.ein_last4}` : null],
    ["Website", reg.website_url],
    ["Number", reg.phone_number],
  ];
  return (
    <div className="rounded-lg border bg-card p-4 text-sm">
      <div className="font-medium">What was filed</div>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words">{v}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}

function issuesByField(err: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  const out: Record<string, string> = {};
  for (const i of err.issues) {
    const key = i.path.map(String).join(".");
    out[key] ??= i.message;
  }
  return out;
}

function RegistrationForm({
  initial,
  status,
  isOwner,
}: {
  initial: Form;
  status: RegistrationStatus | null;
  isOwner: boolean;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Form>(initial);
  const [ein, setEin] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const saveFn = useServerFn(saveTextingDraft);
  const submitFn = useServerFn(submitTextingRegistration);

  const save = useMutation({
    mutationFn: () => saveFn({ data: { ...form, business_type: form.business_type || undefined } }),
    onSuccess: () => {
      toast.success("Details saved");
      qc.invalidateQueries({ queryKey: ["texting-registration"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const submit = useMutation({
    mutationFn: async () => {
      const details = registrationDetailsSchema.safeParse(form);
      const einCheck = einSchema.safeParse(ein);
      const found = {
        ...(details.success ? {} : issuesByField(details.error)),
        ...(einCheck.success ? {} : { ein: einCheck.error.issues[0]?.message ?? "Enter the EIN" }),
      };
      setErrors(found);
      if (!details.success || !einCheck.success) {
        throw new Error("Some details need fixing. They are marked below.");
      }
      return submitFn({ data: { details: details.data, ein: einCheck.data } });
    },
    onSuccess: (r) => {
      setEin("");
      if (r.error) toast.error(r.error);
      else toast.success("Submitted. We'll show carrier review progress here.");
      qc.invalidateQueries({ queryKey: ["texting-registration"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setContact = (i: 0 | 1, k: keyof Contact, v: string) =>
    setForm((f) => {
      const contacts = [...f.contacts] as [Contact, Contact];
      contacts[i] = { ...contacts[i], [k]: v };
      return { ...f, contacts };
    });

  const resubmitting = status === "rejected";
  const busy = save.isPending || submit.isPending;
  const types = useMemo(
    () => Object.entries(BUSINESS_TYPES) as Array<[BusinessType, { label: string }]>,
    [],
  );

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit.mutate();
      }}
      noValidate
    >
      <Section
        title="Your business"
        hint="Enter these exactly as they appear on your IRS EIN letter. Carriers reject a registration whose name does not match."
      >
        <Field id="legal_name" label="Legal business name" error={errors.legal_name}>
          <Input
            id="legal_name"
            value={form.legal_name}
            onChange={(e) => set("legal_name", e.target.value)}
            autoComplete="organization"
          />
        </Field>
        <Field id="dba" label="Doing business as (optional)" error={errors.dba}>
          <Input id="dba" value={form.dba} onChange={(e) => set("dba", e.target.value)} />
        </Field>
        <Field id="business_type" label="Business type" error={errors.business_type}>
          <select
            id="business_type"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm touch:min-h-11"
            value={form.business_type}
            onChange={(e) => set("business_type", e.target.value as BusinessType)}
          >
            <option value="">Choose one</option>
            {types.map(([value, t]) => (
              <option key={value} value={value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="ein"
          label="EIN"
          error={errors.ein}
          hint={
            resubmitting
              ? "Enter it again to resubmit. We send it to Twilio and keep only the last four digits."
              : "We send it to Twilio and keep only the last four digits."
          }
        >
          <Input
            id="ein"
            value={ein}
            onChange={(e) => setEin(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder="12-3456789"
          />
        </Field>
      </Section>

      <Section title="Address" hint="The business address on file with the IRS.">
        <Field id="street" label="Street address" error={errors.street} wide>
          <Input
            id="street"
            value={form.street}
            onChange={(e) => set("street", e.target.value)}
            autoComplete="address-line1"
          />
        </Field>
        <Field id="street2" label="Suite or unit (optional)" error={errors.street2} wide>
          <Input
            id="street2"
            value={form.street2}
            onChange={(e) => set("street2", e.target.value)}
            autoComplete="address-line2"
          />
        </Field>
        <Field id="city" label="City" error={errors.city}>
          <Input
            id="city"
            value={form.city}
            onChange={(e) => set("city", e.target.value)}
            autoComplete="address-level2"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="region" label="State" error={errors.region}>
            <Input
              id="region"
              value={form.region}
              maxLength={2}
              onChange={(e) => set("region", e.target.value.toUpperCase())}
              autoComplete="address-level1"
              placeholder="MI"
            />
          </Field>
          <Field id="postal_code" label="ZIP" error={errors.postal_code}>
            <Input
              id="postal_code"
              value={form.postal_code}
              inputMode="numeric"
              onChange={(e) => set("postal_code", e.target.value)}
              autoComplete="postal-code"
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Website and contact"
        hint="Carriers check that your Privacy Policy and Terms are separate pages on your own website, and that the email is on the same domain."
      >
        <Field id="website_url" label="Website" error={errors.website_url} wide>
          <Input
            id="website_url"
            type="url"
            value={form.website_url}
            onChange={(e) => set("website_url", e.target.value)}
            placeholder="https://yourbusiness.com"
          />
        </Field>
        <Field id="privacy_url" label="Privacy Policy page" error={errors.privacy_url}>
          <Input
            id="privacy_url"
            type="url"
            value={form.privacy_url}
            onChange={(e) => set("privacy_url", e.target.value)}
            placeholder="https://yourbusiness.com/privacy"
          />
        </Field>
        <Field id="terms_url" label="Terms page" error={errors.terms_url}>
          <Input
            id="terms_url"
            type="url"
            value={form.terms_url}
            onChange={(e) => set("terms_url", e.target.value)}
            placeholder="https://yourbusiness.com/terms"
          />
        </Field>
        <Field id="business_email" label="Business email" error={errors.business_email}>
          <Input
            id="business_email"
            type="email"
            value={form.business_email}
            onChange={(e) => set("business_email", e.target.value)}
            autoComplete="email"
          />
        </Field>
        <Field id="business_phone" label="Business phone" error={errors.business_phone}>
          <Input
            id="business_phone"
            type="tel"
            value={form.business_phone}
            onChange={(e) => set("business_phone", e.target.value)}
            autoComplete="tel"
          />
        </Field>
      </Section>

      {([0, 1] as const).map((i) => (
        <Section
          key={i}
          title={`Authorized contact ${i + 1}`}
          hint={
            i === 0
              ? "Someone carriers can reach about this registration, usually you."
              : "A second person at the business."
          }
        >
          <Field id={`c${i}-first`} label="First name" error={errors[`contacts.${i}.first_name`]}>
            <Input
              id={`c${i}-first`}
              value={form.contacts[i].first_name}
              onChange={(e) => setContact(i, "first_name", e.target.value)}
            />
          </Field>
          <Field id={`c${i}-last`} label="Last name" error={errors[`contacts.${i}.last_name`]}>
            <Input
              id={`c${i}-last`}
              value={form.contacts[i].last_name}
              onChange={(e) => setContact(i, "last_name", e.target.value)}
            />
          </Field>
          <Field id={`c${i}-title`} label="Job title" error={errors[`contacts.${i}.title`]}>
            <Input
              id={`c${i}-title`}
              value={form.contacts[i].title}
              onChange={(e) => setContact(i, "title", e.target.value)}
              placeholder="Owner"
            />
          </Field>
          <Field id={`c${i}-email`} label="Email" error={errors[`contacts.${i}.email`]}>
            <Input
              id={`c${i}-email`}
              type="email"
              value={form.contacts[i].email}
              onChange={(e) => setContact(i, "email", e.target.value)}
            />
          </Field>
          <Field id={`c${i}-phone`} label="Mobile phone" error={errors[`contacts.${i}.phone`]}>
            <Input
              id={`c${i}-phone`}
              type="tel"
              value={form.contacts[i].phone}
              onChange={(e) => setContact(i, "phone", e.target.value)}
            />
          </Field>
        </Section>
      ))}

      {errors.contacts && <p className="text-xs text-destructive">{errors.contacts}</p>}

      <div className="space-y-3 rounded-lg border bg-muted/40 p-4 text-xs text-muted-foreground">
        <p>
          When you submit, we create a Twilio account for your business, register your business
          profile, buy a toll-free number in that account, and file its verification with your
          details. Twilio says review takes up to three business days. Your number cannot send texts
          until it is approved.
        </p>
        {!isOwner && (
          <p className="font-medium text-foreground">
            Only the owner can submit. You can save the details for them.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !isOwner}>
          {submit.isPending
            ? "Submitting…"
            : resubmitting
              ? "Resubmit to carriers"
              : "Submit to carriers"}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save details"}
        </Button>
      </div>
    </form>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-lg border bg-card p-4">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function Field({
  id,
  label,
  error,
  hint,
  wide,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`min-w-0 space-y-1 ${wide ? "sm:col-span-2" : ""}`}>
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
