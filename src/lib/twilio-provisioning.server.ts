// Server-only: BUILD-3 (#538). Turning an owner's business details into a
// Twilio subaccount that can text that business's clients, with no Twilio
// console work.
//
// ── THE MODEL ─────────────────────────────────────────────────────────────
//
// One subaccount per business, registered in that business's own name
// (toll-free verification by default). Twilio's ISV guidance: each customer
// gets its own subaccount with its own compliance profile and numbers, and a
// toll-free verification is filed in the END BUSINESS's legal name, EIN,
// website, address and contact, never the ISV's ("Name of the ISV" is
// Twilio's own example of a rejected submission). A verification does not
// carry over between accounts, so each number is bought inside the
// business's own subaccount and never moved.
//
// HoundStack's own toll-free number is not part of any of this. It texts
// account holders only (lib/twilio-credentials.server).
//
// ── THE STEPS, EACH SAVED AS IT COMPLETES ─────────────────────────────────
//
//   1. subaccount            POST /2010-04-01/Accounts.json (parent creds)
//   2. business profile      a SECONDARY customer profile in the parent:
//                            address, business information (with the EIN),
//                            two authorized representatives, the address
//                            document, the parent's own primary profile,
//                            evaluated, then submitted for review
//   3. number                a toll-free number bought in the subaccount, its
//                            incoming-message URL set to the inbound hook
//   4. verification          the toll-free verification, filed as the
//                            subaccount, citing the profile from step 2
//
// Every SID is written to org_texting_registrations the moment Twilio returns
// it, so a submit that fails at step 3 resumes at step 3 and never makes a
// second subaccount or buys a second number.
//
// ── WHAT IS NEVER KEPT ────────────────────────────────────────────────────
//
// The EIN is an argument to `submitTextingRegistration` and goes to Twilio in
// two request bodies; it is not stored (the row keeps the last four), not
// logged, and scrubbed out of any error text before that text is saved or
// shown. The subaccount's auth token is never stored on the registration. It
// is read from Twilio with the parent credentials when a request has to be
// made AS the subaccount, and written once, encrypted, by
// public.activate_org_texting when the verification is approved.
//
// ── ENVIRONMENT ───────────────────────────────────────────────────────────
//
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   the parent (ISV) account
//   TWILIO_PRIMARY_CUSTOMER_PROFILE_SID     the parent's own approved primary
//                                           business profile (BU...), which
//                                           every secondary profile cites
//   TWILIO_COMPLIANCE_EMAIL                 optional: where Twilio sends
//                                           profile status mail (defaults to
//                                           the business's own email)
//   CREDENTIAL_ENCRYPTION_KEY               required to activate

import { appUrl } from "@/lib/app-origin";
import { shouldActivate } from "@/lib/managed-texting";
import {
  BUSINESS_TYPES,
  STALE_SUBMIT_MS,
  einDigits,
  einFormatted,
  statusFromVerification,
  toE164,
  type RegistrationDetails,
  type RegistrationStatus,
} from "@/lib/texting-registration";

const API = "https://api.twilio.com/2010-04-01";
const TRUST_HUB = "https://trusthub.twilio.com/v1";
const MESSAGING = "https://messaging.twilio.com/v1";

/** Twilio's policy for a secondary customer profile (ISV). */
export const SECONDARY_PROFILE_POLICY_SID = "RNdfbf3fae0e1107f8aded0e7cead80bf5";

/** Where each bought number sends incoming texts: the one inbound hook. */
export function inboundSmsUrl(): string {
  return appUrl("/api/public/hooks/twilio");
}

type Auth = { accountSid: string; authToken: string };

export class TwilioSetupError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number | null,
  ) {
    super(message);
    this.name = "TwilioSetupError";
  }
}

function parentAuth(): Auth {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new TwilioSetupError(
      "Texting setup is not configured on our side yet. We have been told; please try again later.",
    );
  }
  return { accountSid, authToken };
}

/**
 * Remove anything secret from text that is about to be saved, logged or
 * shown: the EIN in either spelling, any other nine-digit run, and anything
 * shaped like a Twilio auth token (32 hex characters).
 */
export function scrub(text: string, ein?: string | null): string {
  let out = text;
  if (ein) {
    const d = einDigits(ein);
    if (d) {
      out = out.split(d).join("[EIN]");
      out = out.split(einFormatted(ein)).join("[EIN]");
    }
  }
  return out
    .replace(/\b\d{2}-?\d{7}\b/g, "[number]")
    .replace(/\b[0-9a-f]{32}\b/gi, "[secret]")
    .slice(0, 500);
}

type FormValue = string | number | boolean | string[] | null | undefined;

/** One Twilio REST call. Form-encoded, Basic auth, JSON back. */
async function twilio(
  auth: Auth,
  method: "GET" | "POST" | "DELETE",
  url: string,
  form?: Record<string, FormValue>,
  ein?: string | null,
): Promise<any> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form ?? {})) {
    if (v === null || v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) body.append(k, item);
    else body.set(k, String(v));
  }
  const target = method === "GET" && form ? `${url}?${body.toString()}` : url;
  const res = await fetch(target, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${auth.accountSid}:${auth.authToken}`).toString("base64")}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? body : undefined,
  });
  if (method === "DELETE" && res.ok) return {};
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new TwilioSetupError(
      scrub(`Twilio said: ${json?.message ?? `HTTP ${res.status}`}`, ein),
      res.status,
      json?.code ?? null,
    );
  }
  return json;
}

/** The subaccount's own credentials, read fresh from Twilio with the parent's.
 *  Held in memory for one request and never written anywhere but by
 *  activate_org_texting, encrypted. */
async function subaccountAuth(subSid: string): Promise<Auth> {
  const acct = await twilio(
    parentAuth(),
    "GET",
    `${API}/Accounts/${encodeURIComponent(subSid)}.json`,
  );
  if (!acct?.auth_token)
    throw new TwilioSetupError("Twilio did not return the subaccount's credentials");
  return { accountSid: subSid, authToken: acct.auth_token as string };
}

// ── The request bodies, pure so a test can read them ──────────────────────

export function businessInformationAttributes(d: RegistrationDetails, ein: string) {
  return {
    business_name: d.legal_name,
    business_identity: "direct_customer",
    business_type: BUSINESS_TYPES[d.business_type].trustHub,
    business_industry: "CONSUMER",
    business_registration_identifier: "EIN",
    business_registration_number: einFormatted(ein),
    business_regions_of_operation: "USA_AND_CANADA",
    website_url: d.website_url,
    social_media_profile_urls: "",
  };
}

export function representativeAttributes(c: RegistrationDetails["contacts"][number]) {
  return {
    first_name: c.first_name,
    last_name: c.last_name,
    email: c.email,
    phone_number: toE164(c.phone),
    business_title: c.title,
    job_position: "Other",
  };
}

/** The toll-free verification, filed in the business's own name. Use cases
 *  ACCOUNT_NOTIFICATIONS and CUSTOMER_CARE, as Product locked. */
export function tollFreeVerificationForm(p: {
  details: RegistrationDetails;
  ein: string;
  phoneNumberSid: string;
  customerProfileSid: string | null;
  orgId: string;
  businessName: string;
  bookingUrl: string | null;
  notificationEmail: string;
}) {
  const d = p.details;
  const name = p.businessName.trim() || d.dba?.trim() || d.legal_name;
  const contact = d.contacts[0];
  return {
    BusinessName: d.legal_name,
    DoingBusinessAs: d.dba || undefined,
    BusinessWebsite: d.website_url,
    BusinessStreetAddress: d.street,
    BusinessStreetAddress2: d.street2 || undefined,
    BusinessCity: d.city,
    BusinessStateProvinceRegion: d.region.toUpperCase(),
    BusinessPostalCode: d.postal_code,
    BusinessCountry: "US",
    BusinessContactFirstName: contact.first_name,
    BusinessContactLastName: contact.last_name,
    BusinessContactEmail: contact.email,
    BusinessContactPhone: toE164(contact.phone),
    BusinessType: BUSINESS_TYPES[d.business_type].tollFree,
    BusinessRegistrationNumber: einDigits(p.ein),
    BusinessRegistrationAuthority: "EIN",
    BusinessRegistrationCountry: "US",
    PrivacyPolicyUrl: d.privacy_url,
    TermsAndConditionsUrl: d.terms_url,
    NotificationEmail: p.notificationEmail,
    UseCaseCategories: ["ACCOUNT_NOTIFICATIONS", "CUSTOMER_CARE"],
    UseCaseSummary:
      `${name} is a local service business. It texts its own clients, who have opted in, about ` +
      `their scheduled visits (reminders, on-the-way notices, visit completed), their invoices and ` +
      `payments, sign-in codes for their client portal, and replies to their questions. No marketing.`,
    ProductionMessageSample: `${name}: Hi Sam, this is a reminder your visit is scheduled for Wed, Aug 12. Reply STOP to opt out.`,
    OptInType: "WEB_FORM",
    OptInImageUrls: p.bookingUrl ? [p.bookingUrl] : [d.website_url],
    OptInConfirmationMessage:
      `${name}: You're subscribed to appointment, visit and billing texts. Message frequency varies. ` +
      `Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
    HelpMessageSample:
      `${name}: Service and account messages. For help contact ${d.business_email}. ` +
      `Msg & data rates may apply. Reply STOP to opt out.`,
    MessageVolume: "1,000",
    AgeGatedContent: false,
    TollfreePhoneNumberSid: p.phoneNumberSid,
    CustomerProfileSid: p.customerProfileSid || undefined,
    ExternalReferenceId: p.orgId,
  } satisfies Record<string, FormValue>;
}

// ── The registration row ──────────────────────────────────────────────────

async function admin(): Promise<any> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as any;
}

async function loadRow(orgId: string): Promise<any | null> {
  const { data } = await (
    await admin()
  )
    .from("org_texting_registrations")
    .select("*")
    .eq("organization_id", orgId)
    .maybeSingle();
  return data ?? null;
}

async function save(orgId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await (
    await admin()
  )
    .from("org_texting_registrations")
    .update(patch)
    .eq("organization_id", orgId);
  if (error) throw new TwilioSetupError(`Could not save texting setup: ${error.message}`);
}

/** The columns the owner's details are stored in. No EIN. */
export function detailsColumns(d: RegistrationDetails) {
  return {
    legal_name: d.legal_name,
    business_type: d.business_type,
    dba: d.dba || null,
    street: d.street,
    street2: d.street2 || null,
    city: d.city,
    region: d.region.toUpperCase(),
    postal_code: d.postal_code,
    country: "US",
    website_url: d.website_url,
    privacy_url: d.privacy_url,
    terms_url: d.terms_url,
    business_email: d.business_email,
    business_phone: toE164(d.business_phone),
    contacts: d.contacts.map((c) => ({ ...c, phone: toE164(c.phone) ?? c.phone })),
  };
}

// ── Submit ────────────────────────────────────────────────────────────────

/** The statuses a submit may start from. A "submitting" row joins them once
 *  it is STALE_SUBMIT_MS old: the request that set it died (a closed tab, an
 *  evicted worker, a timeout) before it could record success or failure. */
const SUBMITTABLE = "status.in.(draft,rejected,failed)";

/**
 * File the business's details with Twilio: subaccount, business profile,
 * toll-free number and verification, resuming from whatever an earlier
 * attempt already created. After a rejection it updates the profile and
 * resubmits the same verification. Returns the status it ended in; a failure
 * is recorded on the row (scrubbed) and also returned, never thrown, so the
 * screen can say what happened.
 */
export async function submitTextingRegistration(p: {
  orgId: string;
  userId: string;
  details: RegistrationDetails;
  ein: string;
}): Promise<{ status: RegistrationStatus; error?: string }> {
  const { orgId, details, ein } = p;
  const db = await admin();

  // ── Claim the submit, atomically ───────────────────────────────────────
  //
  // One conditional UPDATE, so two presses of Submit (two tabs, a double
  // tap) cannot both get past this line: the row lock serialises them and
  // the second finds the status already "submitting". A read-then-write here
  // let both through, and the second subaccount's SID overwrote the first,
  // orphaning it in Twilio. A row that does not exist yet is created as a
  // draft first, which is then claimed the same way.
  const { error: seedErr } = await db
    .from("org_texting_registrations")
    .upsert(
      { organization_id: orgId, status: "draft" },
      { onConflict: "organization_id", ignoreDuplicates: true },
    );
  if (seedErr) return { status: "draft", error: `Could not save: ${seedErr.message}` };
  const staleBefore = new Date(Date.now() - STALE_SUBMIT_MS).toISOString();
  const { data: claimed, error: claimErr } = await db
    .from("org_texting_registrations")
    .update({
      ...detailsColumns(details),
      ein_last4: einDigits(ein).slice(-4),
      number_type: "toll_free",
      status: "submitting",
      last_error: null,
      updated_by: p.userId,
      status_changed_at: new Date().toISOString(),
    })
    .eq("organization_id", orgId)
    .or(`${SUBMITTABLE},and(status.eq.submitting,updated_at.lt."${staleBefore}")`)
    .select("organization_id, verification_sid");
  if (claimErr) return { status: "draft", error: `Could not save: ${claimErr.message}` };
  if (!claimed?.length) {
    const now = await loadRow(orgId);
    if (now?.status === "submitting") {
      return { status: "submitting", error: "Setup is already running. Give it a minute." };
    }
    return { status: now?.status ?? "draft", error: "This registration is already with Twilio." };
  }
  // A verification already on file means this is a refiling: after a
  // rejection, or after a refiling that itself failed.
  const resubmitting = Boolean(claimed[0].verification_sid);

  try {
    const parent = parentAuth();
    const { data: org } = await db
      .from("organizations")
      .select("name, slug")
      .eq("id", orgId)
      .maybeSingle();
    const businessName = (org?.name as string | null) ?? details.dba ?? details.legal_name;
    const bookingUrl = org?.slug ? appUrl(`/signup/${org.slug}`) : null;
    let reg = (await loadRow(orgId))!;

    // 1. Subaccount. Its token is in this response and deliberately dropped.
    if (!reg.subaccount_sid) {
      const acct = await twilio(parent, "POST", `${API}/Accounts.json`, {
        FriendlyName: `${details.legal_name} (HoundStack ${orgId})`.slice(0, 64),
      });
      await save(orgId, { subaccount_sid: acct.sid });
      reg = { ...reg, subaccount_sid: acct.sid };
    }

    // 2. Business profile (secondary customer profile, in the parent).
    reg = await ensureBusinessProfile(parent, orgId, reg, details, ein, resubmitting);

    // 3. Number, bought in the subaccount, incoming texts to the one hook.
    if (!reg.phone_number_sid) {
      const sub = encodeURIComponent(reg.subaccount_sid);
      const avail = await twilio(
        parent,
        "GET",
        `${API}/Accounts/${sub}/AvailablePhoneNumbers/US/TollFree.json`,
        {
          SmsEnabled: true,
          PageSize: 5,
        },
      );
      const pick = avail?.available_phone_numbers?.[0]?.phone_number as string | undefined;
      if (!pick)
        throw new TwilioSetupError(
          "Twilio has no toll-free numbers available right now. Try again later.",
        );
      const bought = await twilio(
        parent,
        "POST",
        `${API}/Accounts/${sub}/IncomingPhoneNumbers.json`,
        {
          PhoneNumber: pick,
          FriendlyName: businessName.slice(0, 64),
          SmsUrl: inboundSmsUrl(),
          SmsMethod: "POST",
        },
      );
      await save(orgId, { phone_number_sid: bought.sid, phone_number: bought.phone_number });
      reg = { ...reg, phone_number_sid: bought.sid, phone_number: bought.phone_number };
    }

    // 4. Verification, as the subaccount, in the business's own name.
    const subAuth = await subaccountAuth(reg.subaccount_sid);
    const form = tollFreeVerificationForm({
      details,
      ein,
      phoneNumberSid: reg.phone_number_sid,
      customerProfileSid: reg.customer_profile_sid,
      orgId,
      businessName,
      bookingUrl,
      notificationEmail: process.env.TWILIO_COMPLIANCE_EMAIL || details.business_email,
    });
    let verification: any;
    if (reg.verification_sid) {
      // A refiling edits the verification Twilio already has, which keeps
      // its seven-day priority window. It is deleted and filed afresh ONLY
      // when Twilio says it can no longer be edited (or it is gone). Any
      // other failure (a 5xx, a dropped connection, a field Twilio refuses)
      // is recorded as "failed" with the SID kept, so nothing is thrown away
      // on a blip and the owner can simply submit again.
      const url = `${MESSAGING}/Tollfree/Verifications/${encodeURIComponent(reg.verification_sid)}`;
      const current = await twilio(subAuth, "GET", url).catch((e: TwilioSetupError) => {
        if (e.status === 404) return null;
        throw e;
      });
      if (current && current.edit_allowed !== false) {
        verification = await twilio(
          subAuth,
          "POST",
          url,
          { ...form, EditReason: "Updated the business details after review." },
          ein,
        );
      } else {
        if (current) await twilio(subAuth, "DELETE", url);
        verification = await twilio(
          subAuth,
          "POST",
          `${MESSAGING}/Tollfree/Verifications`,
          form,
          ein,
        );
      }
    } else {
      verification = await twilio(
        subAuth,
        "POST",
        `${MESSAGING}/Tollfree/Verifications`,
        form,
        ein,
      );
    }

    const now = new Date().toISOString();
    await save(orgId, {
      verification_sid: verification.sid,
      verification_status: verification.status ?? "PENDING_REVIEW",
      // The poll moves it on from here; a fresh filing is always in review.
      status: "submitted",
      submitted_at: now,
      status_changed_at: now,
      checked_at: now,
      rejection_reason: null,
      rejection_code: null,
      resubmit_deadline: null,
      rejection_alerted_at: null,
      last_error: null,
    });
    return { status: "submitted" };
  } catch (e) {
    const message = scrub(
      e instanceof TwilioSetupError ? e.message : "Something went wrong talking to Twilio.",
      ein,
    );
    console.error("texting setup failed", orgId, message);
    await save(orgId, {
      status: "failed",
      last_error: message,
      status_changed_at: new Date().toISOString(),
    }).catch(() => undefined);
    return { status: "failed", error: message };
  }
}

async function ensureBusinessProfile(
  parent: Auth,
  orgId: string,
  reg: any,
  d: RegistrationDetails,
  ein: string,
  resubmitting: boolean,
): Promise<any> {
  const primary = process.env.TWILIO_PRIMARY_CUSTOMER_PROFILE_SID;
  if (!primary) {
    throw new TwilioSetupError(
      "Texting setup is not configured on our side yet. We have been told; please try again later.",
    );
  }
  const addressForm = {
    CustomerName: d.legal_name,
    Street: d.street,
    StreetSecondary: d.street2 || undefined,
    City: d.city,
    Region: d.region.toUpperCase(),
    PostalCode: d.postal_code,
    IsoCountry: "US",
    FriendlyName: d.legal_name.slice(0, 64),
  };
  const next = { ...reg };

  if (!next.address_sid) {
    const a = await twilio(
      parent,
      "POST",
      `${API}/Accounts/${encodeURIComponent(parent.accountSid)}/Addresses.json`,
      addressForm,
    );
    next.address_sid = a.sid;
    await save(orgId, { address_sid: a.sid });
  } else if (resubmitting) {
    await twilio(
      parent,
      "POST",
      `${API}/Accounts/${encodeURIComponent(parent.accountSid)}/Addresses/${encodeURIComponent(next.address_sid)}.json`,
      addressForm,
    );
  }

  const info = JSON.stringify(businessInformationAttributes(d, ein));
  if (!next.business_end_user_sid) {
    const u = await twilio(
      parent,
      "POST",
      `${TRUST_HUB}/EndUsers`,
      {
        FriendlyName: `${d.legal_name} business information`.slice(0, 64),
        Type: "customer_profile_business_information",
        Attributes: info,
      },
      ein,
    );
    next.business_end_user_sid = u.sid;
    await save(orgId, { business_end_user_sid: u.sid });
  } else if (resubmitting) {
    await twilio(
      parent,
      "POST",
      `${TRUST_HUB}/EndUsers/${encodeURIComponent(next.business_end_user_sid)}`,
      { Attributes: info },
      ein,
    );
  }

  const reps: string[] = [...(next.representative_end_user_sids ?? [])];
  for (let i = 0; i < 2; i++) {
    const attrs = JSON.stringify(representativeAttributes(d.contacts[i]));
    if (!reps[i]) {
      const u = await twilio(parent, "POST", `${TRUST_HUB}/EndUsers`, {
        FriendlyName: `${d.contacts[i].first_name} ${d.contacts[i].last_name}`.slice(0, 64),
        Type: `authorized_representative_${i + 1}`,
        Attributes: attrs,
      });
      reps[i] = u.sid;
      await save(orgId, { representative_end_user_sids: reps });
    } else if (resubmitting) {
      await twilio(parent, "POST", `${TRUST_HUB}/EndUsers/${encodeURIComponent(reps[i])}`, {
        Attributes: attrs,
      });
    }
  }
  next.representative_end_user_sids = reps;

  if (!next.address_document_sid) {
    const doc = await twilio(parent, "POST", `${TRUST_HUB}/SupportingDocuments`, {
      FriendlyName: `${d.legal_name} address`.slice(0, 64),
      Type: "customer_profile_address",
      Attributes: JSON.stringify({ address_sids: next.address_sid }),
    });
    next.address_document_sid = doc.sid;
    await save(orgId, { address_document_sid: doc.sid });
  }

  if (!next.customer_profile_sid) {
    const profile = await twilio(parent, "POST", `${TRUST_HUB}/CustomerProfiles`, {
      FriendlyName: `${d.legal_name} (HoundStack ${orgId})`.slice(0, 64),
      Email: process.env.TWILIO_COMPLIANCE_EMAIL || d.business_email,
      PolicySid: SECONDARY_PROFILE_POLICY_SID,
    });
    next.customer_profile_sid = profile.sid;
    await save(orgId, {
      customer_profile_sid: profile.sid,
      customer_profile_status: profile.status ?? "draft",
    });
    const bu = encodeURIComponent(profile.sid);
    for (const objectSid of [
      next.business_end_user_sid,
      ...reps,
      next.address_document_sid,
      primary,
    ]) {
      await twilio(parent, "POST", `${TRUST_HUB}/CustomerProfiles/${bu}/EntityAssignments`, {
        ObjectSid: objectSid,
      });
    }
  }

  const bu = encodeURIComponent(next.customer_profile_sid);
  const evaluation = await twilio(
    parent,
    "POST",
    `${TRUST_HUB}/CustomerProfiles/${bu}/Evaluations`,
    {
      PolicySid: SECONDARY_PROFILE_POLICY_SID,
    },
  );
  if (evaluation?.status && evaluation.status !== "compliant") {
    throw new TwilioSetupError(
      `Twilio found something missing in the business profile: ${evaluationProblems(evaluation)}`,
    );
  }
  const submitted = await twilio(parent, "POST", `${TRUST_HUB}/CustomerProfiles/${bu}`, {
    Status: "pending-review",
  }).catch((e: TwilioSetupError) => {
    // Already in review (a resumed submit): fine, carry on to the number.
    if (e.status === 400) return { status: next.customer_profile_status };
    throw e;
  });
  next.customer_profile_status = submitted?.status ?? "pending-review";
  await save(orgId, { customer_profile_status: next.customer_profile_status });
  return next;
}

function evaluationProblems(evaluation: any): string {
  const fields: string[] = [];
  for (const r of evaluation?.results ?? []) {
    for (const f of r?.fields ?? []) {
      if (f?.passed === false && f?.friendly_name) fields.push(String(f.friendly_name));
    }
  }
  return fields.length ? fields.slice(0, 5).join(", ") : "check every field and try again";
}

// ── Status ────────────────────────────────────────────────────────────────

/**
 * Ask Twilio where one business's verification stands and record it. On
 * approval, turn texting on (activateTexting) only if a HoundStack admin has
 * also activated it (site-r2-05: `shouldActivate`); until then the business
 * reads "Under review". On a new rejection, alert HoundStack and the
 * business's owners once.
 */
export async function refreshTextingStatus(orgId: string): Promise<RegistrationStatus | null> {
  const reg = await loadRow(orgId);
  if (!reg?.verification_sid || !reg.subaccount_sid) return reg?.status ?? null;
  const now = new Date().toISOString();

  if (reg.status === "approved") {
    // Approved and already sending: nothing to ask Twilio and nothing to
    // write. Only an approval whose activation has not landed (a missing
    // key, a failed write) is finished here, and only once an admin has
    // activated it: an approval alone waits for the admin.
    if (shouldActivate(reg) && !(await hasCredentials(orgId))) await activateTexting(orgId, reg);
    return "approved";
  }
  if (!["submitted", "in_review", "rejected"].includes(reg.status)) return reg.status;

  const subAuth = await subaccountAuth(reg.subaccount_sid);
  const v = await twilio(
    subAuth,
    "GET",
    `${MESSAGING}/Tollfree/Verifications/${encodeURIComponent(reg.verification_sid)}`,
  );
  const status = statusFromVerification(v?.status);
  const patch: Record<string, unknown> = {
    verification_status: v?.status ?? reg.verification_status,
    checked_at: now,
  };
  if (status !== reg.status) {
    patch.status = status;
    patch.status_changed_at = now;
  }
  if (status === "rejected") {
    patch.rejection_reason = v?.rejection_reason ? scrub(String(v.rejection_reason)) : null;
    patch.rejection_code = v?.error_code != null ? String(v.error_code) : null;
    patch.resubmit_deadline = v?.edit_expiration ?? null;
  }
  if (status === "approved") patch.approved_at = now;
  await save(orgId, patch);

  if (status === "rejected" && !reg.rejection_alerted_at) {
    await alertRejection(orgId, {
      legalName: reg.legal_name,
      reason: (patch.rejection_reason as string | null) ?? null,
      code: (patch.rejection_code as string | null) ?? null,
      deadline: (patch.resubmit_deadline as string | null) ?? null,
    });
    await save(orgId, { rejection_alerted_at: now });
  }
  if (shouldActivate({ ...reg, ...patch })) await activateTexting(orgId, { ...reg, ...patch });
  return status;
}

/**
 * site-r2-05: the admin/ops action that takes a business out of "Under
 * review". Records the admin's activation (once; a second press changes
 * nothing), then switches texting on if Twilio has approved the
 * verification, asking Twilio first if it has not said so yet. If the carrier
 * is still reviewing, the activation stands and the poll switches texting on
 * the moment it approves.
 *
 * Refuses a business that does not hold the add-on, and a registration that
 * is not under review (a draft, a rejection, a stopped setup).
 */
export async function opsActivateTexting(
  orgId: string,
  adminUserId: string,
): Promise<{ status: RegistrationStatus; live: boolean }> {
  const reg = await loadRow(orgId);
  if (!reg || !["submitted", "in_review", "approved"].includes(reg.status)) {
    throw new Error("This business has no texting registration under review.");
  }
  const { orgHoldsManagedTexting } = await import("@/lib/managed-texting.server");
  if (!(await orgHoldsManagedTexting(orgId))) {
    throw new Error("This business does not have the Managed texting add-on on its plan.");
  }
  const now = new Date().toISOString();
  // From NULL once, conditionally, so two admins pressing at once record one.
  await (await admin())
    .from("org_texting_registrations")
    .update({ ops_approved_at: now, ops_approved_by: adminUserId })
    .eq("organization_id", orgId)
    .is("ops_approved_at", null)
    .select("organization_id");
  const status = await refreshTextingStatus(orgId);
  return { status: status ?? reg.status, live: await hasCredentials(orgId) };
}

/**
 * Approval only: the subaccount's token, encrypted, into
 * org_twilio_credentials, and the number into organizations.sms_from_number,
 * in one transaction (public.activate_org_texting refuses anything else).
 * After this, orgCanTextClients is true for this business and nobody else.
 */
export async function activateTexting(orgId: string, reg: any): Promise<void> {
  const { encryptSecret } = await import("@/lib/secret-encryption.server");
  const sub = await subaccountAuth(reg.subaccount_sid);
  const ciphertext = encryptSecret(sub.authToken);
  const { error } = await (
    await admin()
  ).rpc("activate_org_texting", {
    _org_id: orgId,
    _account_sid: reg.subaccount_sid,
    _auth_token: ciphertext,
    _token_last4: sub.authToken.slice(-4),
    _from: reg.phone_number,
  });
  if (error) {
    // The message is the function's own (no secret is ever in it).
    console.error("texting activation failed", orgId, error.message);
    await save(orgId, { last_error: `Approved, but turning texting on failed: ${error.message}` });
    return;
  }
  // Stamped from null exactly once, by a conditional UPDATE, and the owner
  // is told only by the call that set it. A later re-activation (a lost
  // credential row being restored) does not tell anybody a second time.
  const { data: firstTime } = await (
    await admin()
  )
    .from("org_texting_registrations")
    .update({ last_error: null, activated_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .is("activated_at", null)
    .select("organization_id");
  if (!firstTime?.length) {
    await save(orgId, { last_error: null });
    return;
  }
  try {
    const { notifyRoles } = await import("@/lib/notify-center.server");
    await notifyRoles(["owner"], {
      orgId,
      type: "texting_approved",
      title: "Texting is live",
      body: `Carriers approved your number ${reg.phone_number}. Texts to clients who opted in now go out from it.`,
      link: "/settings/sms",
    });
  } catch (e) {
    console.warn("texting approval notice failed", (e as Error).message);
  }
}

/** Whether this business already has its credential row, i.e. is sending. */
async function hasCredentials(orgId: string): Promise<boolean> {
  const { data } = await (
    await admin()
  )
    .from("org_twilio_credentials")
    .select("organization_id")
    .eq("organization_id", orgId)
    .maybeSingle();
  return Boolean(data);
}

/**
 * Every open registration, for the ten-minute poll. Counts only. The same
 * set public.texting_status_due() answers for: with Twilio, or approved AND
 * activated by an admin with no credential row yet. A business that is already live is not touched, so
 * one filing in review does not re-activate (or re-notify) every live one.
 */
export async function refreshAllTextingStatuses(): Promise<Record<string, number>> {
  const db = await admin();
  const { data: open } = await db
    .from("org_texting_registrations")
    .select("organization_id, status, ops_approved_at")
    .in("status", ["submitted", "in_review", "approved"]);
  // An approval no admin has activated has nothing to ask Twilio and nothing
  // to switch on: it waits on /platform/addons, not on the poll.
  const data = (open ?? []).filter((r: any) => r.status !== "approved" || shouldActivate(r));
  const approved = data
    .filter((r: any) => r.status === "approved")
    .map((r: any) => r.organization_id);
  const { data: live } = approved.length
    ? await db
        .from("org_twilio_credentials")
        .select("organization_id")
        .in("organization_id", approved)
    : { data: [] as any[] };
  const sending = new Set((live ?? []).map((r: any) => r.organization_id));
  const counts: Record<string, number> = { checked: 0, errors: 0 };
  for (const r of data.filter((r: any) => !sending.has(r.organization_id))) {
    try {
      const s = await refreshTextingStatus(r.organization_id);
      counts.checked++;
      if (s) counts[s] = (counts[s] ?? 0) + 1;
    } catch (e) {
      counts.errors++;
      console.error("texting status check failed", r.organization_id, scrub((e as Error).message));
    }
  }
  return counts;
}

/**
 * A rejection, told to HoundStack (every platform admin, plus
 * TEXTING_ALERT_EMAIL if set) by email, and to the business's owners in the
 * app. Twilio gives a priority window of seven days to fix and resubmit.
 */
async function alertRejection(
  orgId: string,
  r: {
    legalName: string | null;
    reason: string | null;
    code: string | null;
    deadline: string | null;
  },
): Promise<void> {
  const db = await admin();
  const { data: org } = await db.from("organizations").select("name").eq("id", orgId).maybeSingle();
  const business = (org?.name as string | null) ?? r.legalName ?? orgId;
  const lines = [
    `Twilio rejected the toll-free verification for ${business} (${r.legalName ?? "legal name not on file"}).`,
    `Reason: ${r.reason ?? "none given"}${r.code ? ` (error ${r.code})` : ""}.`,
    `Resubmit by: ${r.deadline ? new Date(r.deadline).toUTCString() : "no deadline given"}. Fixes inside 7 days get priority review.`,
    `Organization: ${orgId}. The owner can fix and resubmit in Settings, Texting.`,
  ];
  console.error("texting verification rejected", orgId, r.code ?? "", r.reason ?? "");

  try {
    const recipients = new Set<string>();
    if (process.env.TEXTING_ALERT_EMAIL)
      recipients.add(process.env.TEXTING_ALERT_EMAIL.toLowerCase());
    const { data: admins } = await db.from("platform_admins").select("user_id");
    for (const a of admins ?? []) {
      try {
        const { data: u } = await db.auth.admin.getUserById(a.user_id);
        if (u?.user?.email) recipients.add(u.user.email.toLowerCase());
      } catch {
        /* one missing admin does not stop the alert */
      }
    }
    const text = lines.join("\n\n");
    const html = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
    for (const to of recipients) {
      const messageId = crypto.randomUUID();
      await db.from("email_send_log").insert({
        message_id: messageId,
        template_name: "texting_rejected",
        recipient_email: to,
        status: "pending",
      });
      await db.rpc("enqueue_email", {
        queue_name: "transactional_emails",
        payload: {
          message_id: messageId,
          to,
          from: "HoundStack <noreply@notify.houndstack.com>",
          sender_domain: "notify.houndstack.com",
          subject: `[HoundStack] Texting verification rejected: ${business}`,
          html,
          text,
          purpose: "transactional",
          label: "texting_rejected",
          idempotency_key: `texting-rejected:${orgId}:${r.deadline ?? r.code ?? "x"}:${to}`,
          queued_at: new Date().toISOString(),
        },
      });
    }
  } catch (e) {
    console.error("texting rejection email failed", (e as Error).message);
  }

  try {
    const { notifyRoles } = await import("@/lib/notify-center.server");
    await notifyRoles(["owner"], {
      orgId,
      type: "texting_rejected",
      title: "Texting registration needs a fix",
      body: `Carriers rejected it: ${r.reason ?? "no reason given"}. Fix it and resubmit in Settings.`,
      link: "/settings/sms",
    });
  } catch (e) {
    console.warn("texting rejection notice failed", (e as Error).message);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
