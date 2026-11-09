// Brand chrome for every email the product sends (#577).
//
// Three kinds of mail, two kinds of chrome:
//
// - System mail (sign-in links, recovery, email change, team invites, the
//   weekly digest) comes from HoundStack. It opens with the HoundStack band
//   and closes with SystemFooter, whose body is CompanySignature: the
//   company version of the team's Gmail signature (logo, tagline, support,
//   web, and the legal line naming The North Consulting LLC). No person's
//   name, ever: it is the company signing, not a founder.
// - Tenant mail (invoices, visit notes, reminders, campaigns) is sent AS the
//   business. It opens with that business's logo, or its name, over a stripe
//   in its brand colour, and closes with OrgFooter, which ends "Powered by
//   HoundStack" over the signature's support, web and legal lines.
//
// Every piece is a table, not flex or grid: this is email, and Outlook is
// still Outlook. Colours a tenant typed in are checked before they reach a
// style attribute, and only text the platform controls ever sits on a colour,
// so a pale brand colour cannot make anything unreadable.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Body, Container, Head, Html, Preview, Section } from "@react-email/components";
import { APP_NAME } from "@/lib/scoop";
import { appUrl } from "@/lib/app-origin";

export const HOUNDSTACK_URL = "https://houndstack.com";

/** The support address the trial notice already gives. */
export const SUPPORT_EMAIL = "support@houndstack.com";

/** The reversed wordmark (white "Hound", sage "Stack") from
 *  src/assets/houndstack-wordmark.svg, as a 2x PNG served from public/brand.
 *  A PNG because Gmail and Outlook do not render an SVG <img>. Never a CSS
 *  filter over the colour wordmark. */
export const WORDMARK_REVERSED_PATH = "/brand/houndstack-wordmark-reversed.png";

/** The app's --brand and --brand-ink tokens (styles.css), as hex. Email
 *  clients do not read oklch. */
export const BRAND = {
  green: "#267b4c",
  ink: "#09311b",
  /** Website navy and sage, for the HoundStack header band (Beacon, #577). */
  navy: "#142937",
  sage: "#5e845e",
  muted: "#64748b",
  rule: "#e2e8f0",
};

/** The company signature every system email closes with, and the HoundStack
 *  part of every tenant email's close (Nov 2026). It is the company version
 *  of the team's Gmail signature: the same logo, navy, tagline, support
 *  address, web link and legal line, and deliberately no person's name. The
 *  logo is the absolute PNG the Gmail signature uses, 60x60. */
export const COMPANY = {
  logoUrl: "https://www.houndstack.com/icon-192.png",
  logoSize: 60,
  tagline: "Business software for route-based pet service businesses",
  webLabel: "houndstack.com",
  legalLead: `${APP_NAME} is a product of`,
  legalLine: "The North Consulting LLC, 2222 West Grand River Avenue, Ste A, Okemos, MI 48864",
  /** The signature's own colours (Gmail signature, Nov 2026). */
  ink: "#111827",
  grey: "#6b7280",
  link: "#1f2937",
  faint: "#9ca3af",
  divider: "#d1d5db",
  hairline: "#e5e7eb",
} as const;

/** The same signature as plain text, for the text/plain part of mail whose
 *  HTML is built by hand. Mail rendered with react-email derives its text
 *  part from the HTML (EMAIL_TEXT_OPTIONS), so it carries the same lines. */
export const COMPANY_SIGNATURE_TEXT = [
  APP_NAME,
  COMPANY.tagline,
  `Email: ${SUPPORT_EMAIL}`,
  `Web: ${COMPANY.webLabel} (${HOUNDSTACK_URL})`,
  "",
  COMPANY.legalLead,
  COMPANY.legalLine,
].join("\n");

/** A #rgb or #rrggbb colour, lower-cased and expanded, or null. Anything else
 *  a tenant saved (a name, an rgb(), a stray quote) is dropped, not passed
 *  into a style attribute. */
export function safeHexColor(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

/** An https logo URL, or null. An http image is blocked or warned about by
 *  most clients, and a data: URL is stripped by Gmail. */
export function safeLogoUrl(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

const small = { fontSize: "12px", color: BRAND.muted, lineHeight: "1.5", margin: 0 };
const table = { width: "100%", borderCollapse: "collapse" as const };

/** The wordmark's drawn size. Its artwork is 3626.5 x 434.8, so 32px tall
 *  is 267px wide; the PNG is drawn at twice that. */
const WORDMARK_HEIGHT = 32;
const WORDMARK_WIDTH = 267;

/** The grey canvas, white card and inset that system mail sits in. Exported
 *  for the platform mail that builds its HTML by hand, so it can line up. */
export const SYSTEM = {
  canvas: "#f4f6f8",
  cardRule: "#e2e8f0",
  radius: "14px",
  inset: "36px",
  /** A soft lift for the card where a client draws shadows; the 1px rule
   *  stands in where it does not. */
  shadow: "0 1px 2px rgba(20,41,55,0.06), 0 8px 24px rgba(20,41,55,0.08)",
};

/**
 * Top of every system email: a sage rule over a navy band carrying the
 * reversed HoundStack wordmark, rounded at the top so the white card below
 * reads as its continuation (Beacon, #577). An image, never typeset text,
 * and never a CSS filter over the colour wordmark.
 */
export function SystemHeader() {
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      style={{
        ...table,
        borderCollapse: "separate" as const,
        borderRadius: `${SYSTEM.radius} ${SYSTEM.radius} 0 0`,
        overflow: "hidden",
      }}
    >
      <tbody>
        <tr>
          <td style={{ backgroundColor: BRAND.sage, height: "6px", fontSize: 0, lineHeight: 0 }}>
            &nbsp;
          </td>
        </tr>
        <tr>
          <td style={{ backgroundColor: BRAND.navy, padding: `30px ${SYSTEM.inset}` }}>
            <a href={HOUNDSTACK_URL} style={{ textDecoration: "none" }}>
              <img
                src={appUrl(WORDMARK_REVERSED_PATH)}
                alt={APP_NAME}
                width={WORDMARK_WIDTH}
                height={WORDMARK_HEIGHT}
                style={{
                  display: "block",
                  width: `${WORDMARK_WIDTH}px`,
                  height: `${WORDMARK_HEIGHT}px`,
                  border: 0,
                  // What a client that blocks images shows instead.
                  color: "#ffffff",
                  fontSize: "20px",
                  fontWeight: "bold" as const,
                }}
              />
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

const ARIAL = "Arial, Helvetica, sans-serif";
const sigCell = { fontFamily: ARIAL, fontSize: "12px", lineHeight: "18px", padding: 0 };
const sigLabel = {
  ...sigCell,
  color: BRAND.navy,
  fontWeight: "bold" as const,
  padding: "0 8px 0 0",
  width: "44px",
};
const sigLink = { fontFamily: ARIAL, color: COMPANY.link, textDecoration: "none" };
const collapse = { borderCollapse: "collapse" as const };

/** "Email support@houndstack.com" and "Web houndstack.com", labelled in navy,
 *  as in the Gmail signature. Shared by the system signature and the
 *  HoundStack close on tenant mail. The hs-sig-* classes are for the text
 *  part only (EMAIL_TEXT_OPTIONS), so each row reads "Email: support@…" on
 *  one line rather than a label and its value on two. */
function CompanyContactRows() {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} border={0} style={collapse}>
      <tbody>
        <tr className="hs-sig-row">
          <td width={44} className="hs-sig-key" style={sigLabel}>
            Email
          </td>
          <td className="hs-sig-value" style={sigCell}>
            <a href={`mailto:${SUPPORT_EMAIL}`} style={sigLink}>
              {SUPPORT_EMAIL}
            </a>
          </td>
        </tr>
        <tr className="hs-sig-row">
          <td width={44} className="hs-sig-key" style={sigLabel}>
            Web
          </td>
          <td className="hs-sig-value" style={sigCell}>
            <a href={HOUNDSTACK_URL} style={sigLink}>
              {COMPANY.webLabel}
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** The legal line under a hairline: who HoundStack belongs to and where. */
function CompanyLegal() {
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      width="100%"
      style={{ ...collapse, width: "100%" }}
    >
      <tbody>
        <tr>
          <td
            style={{
              fontFamily: ARIAL,
              fontSize: "10px",
              lineHeight: "15px",
              color: COMPANY.faint,
              padding: "10px 0 0 0",
              borderTop: `1px solid ${COMPANY.hairline}`,
            }}
          >
            {COMPANY.legalLead}
            <br />
            {COMPANY.legalLine}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * The company signature: the HoundStack logo beside the name, tagline,
 * support address and web link, then the legal line. The company version of
 * the team's Gmail signature, markup and all (tables, inline styles, an
 * absolute PNG), with no person's name in it. Every system email closes with
 * this, through SystemFooter, SystemLayout and systemFooterHtml, so there is
 * one copy of it and no template carries its own.
 *
 * The outer table is 100% wide up to 520px rather than a fixed 520, so it
 * fits a 320px phone; Outlook, which ignores max-width, gets the card's own
 * width.
 */
export function CompanySignature() {
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      border={0}
      width="100%"
      style={{
        fontFamily: ARIAL,
        width: "100%",
        maxWidth: "520px",
        ...collapse,
        // Outlook's own table spacing, as in the Gmail signature. Not in
        // React's CSSProperties, so cast; React hyphenates it as written.
        ...({ msoTableLspace: "0pt", msoTableRspace: "0pt" } as React.CSSProperties),
      }}
    >
      <tbody>
        <tr>
          <td style={{ padding: 0 }}>
            <table role="presentation" cellPadding={0} cellSpacing={0} border={0} style={collapse}>
              <tbody>
                <tr>
                  <td valign="middle" style={{ padding: "0 18px 0 0", verticalAlign: "middle" }}>
                    <a
                      href={HOUNDSTACK_URL}
                      className="hs-sig-logo"
                      style={{ textDecoration: "none" }}
                    >
                      <img
                        src={COMPANY.logoUrl}
                        width={COMPANY.logoSize}
                        height={COMPANY.logoSize}
                        alt={APP_NAME}
                        style={{
                          display: "block",
                          width: `${COMPANY.logoSize}px`,
                          height: `${COMPANY.logoSize}px`,
                          border: 0,
                          outline: "none",
                          textDecoration: "none",
                        }}
                      />
                    </a>
                  </td>
                  <td
                    valign="top"
                    style={{
                      padding: "2px 0 2px 18px",
                      borderLeft: `1px solid ${COMPANY.divider}`,
                      verticalAlign: "top",
                    }}
                  >
                    <table
                      role="presentation"
                      cellPadding={0}
                      cellSpacing={0}
                      border={0}
                      style={collapse}
                    >
                      <tbody>
                        <tr>
                          <td
                            style={{
                              fontFamily: ARIAL,
                              fontSize: "16px",
                              lineHeight: "20px",
                              fontWeight: "bold" as const,
                              color: COMPANY.ink,
                              padding: 0,
                            }}
                          >
                            {APP_NAME}
                          </td>
                        </tr>
                        <tr>
                          <td
                            style={{
                              fontFamily: ARIAL,
                              fontSize: "12px",
                              lineHeight: "17px",
                              color: COMPANY.grey,
                              padding: "2px 0 8px 0",
                            }}
                          >
                            {COMPANY.tagline}
                          </td>
                        </tr>
                        <tr>
                          <td style={{ padding: 0 }}>
                            <CompanyContactRows />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>
          </td>
        </tr>
        <tr>
          <td style={{ padding: "14px 0 0 0" }}>
            <CompanyLegal />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** Bottom of every system email. `note` is the email's own last line (why
 *  it was sent, how to stop it), printed above the company signature.
 *  `poweredBy` is for system mail that carries a business's header (the
 *  weekly digest): it closes with PoweredByHoundStack, as tenant mail does.
 *  `onCanvas` is for mail laid out as a card on the grey canvas: the footer
 *  sits below the card, inset to line up with the card's text, with no rule
 *  of its own because the card's edge already is one. */
export function SystemFooter({
  note,
  poweredBy,
  onCanvas,
}: {
  note?: React.ReactNode;
  poweredBy?: boolean;
  onCanvas?: boolean;
}) {
  if (onCanvas) return <CanvasFooter note={note} />;
  return (
    <>
      <table
        role="presentation"
        cellPadding={0}
        cellSpacing={0}
        style={{ ...table, margin: "32px 0 0", borderTop: `1px solid ${BRAND.rule}` }}
      >
        <tbody>
          {note ? (
            <tr>
              <td style={{ ...small, padding: "16px 0 0" }}>{note}</td>
            </tr>
          ) : null}
          {poweredBy ? null : (
            <tr>
              <td style={{ padding: "24px 0 0" }}>
                <CompanySignature />
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {/* The weekly digest: system mail about a business. Its note, then the
          same close tenant mail ends with. */}
      {poweredBy ? <PoweredByHoundStack /> : null}
    </>
  );
}

/** The short sage rule that opens every HoundStack close, system or tenant. */
function SageRule() {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ margin: 0 }}>
      <tbody>
        <tr>
          <td
            style={{
              width: "32px",
              height: "3px",
              backgroundColor: BRAND.sage,
              fontSize: 0,
              lineHeight: 0,
            }}
          >
            &nbsp;
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** How far the signature under the card sits in from the card's edge.
 *  Narrower than the card's own 36px text inset on purpose: the signature's
 *  narrowest row (logo, rule, "Email support@houndstack.com") is about 290px
 *  and cannot wrap, so at 36px a side it pushed a 360px phone sideways. */
const SIGNATURE_INSET = "16px";

/** The footer under a system email's card: the email's own note, a short
 *  sage rule, then the company signature. */
function CanvasFooter({ note }: { note?: React.ReactNode }) {
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      style={{ ...table, margin: "28px 0 0" }}
    >
      <tbody>
        {note ? (
          <tr>
            <td style={{ ...small, padding: `0 ${SYSTEM.inset} 20px`, color: "#475569" }}>
              {note}
            </td>
          </tr>
        ) : null}
        <tr>
          <td style={{ padding: `0 ${SIGNATURE_INSET} 18px` }}>
            <SageRule />
          </td>
        </tr>
        <tr>
          <td style={{ padding: `0 ${SIGNATURE_INSET}` }}>
            <CompanySignature />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** Shared type for system mail laid out with SystemLayout. */
export const systemText = {
  h1: {
    fontSize: "26px",
    lineHeight: "1.25",
    fontWeight: "bold" as const,
    letterSpacing: "-0.2px",
    color: BRAND.navy,
    margin: "0 0 18px",
  },
  text: { fontSize: "16px", color: "#334155", lineHeight: "1.6", margin: "0 0 20px" },
  link: { color: "inherit", textDecoration: "underline" },
  button: {
    backgroundColor: BRAND.navy,
    color: "#ffffff",
    fontSize: "16px",
    fontWeight: "bold" as const,
    borderRadius: "10px",
    padding: "15px 28px",
    margin: "8px 0 4px",
    textDecoration: "none",
    display: "inline-block",
  },
  /** The email's own "if you didn't ask for this" line, last in the card. */
  aside: {
    fontSize: "13px",
    color: "#64748b",
    lineHeight: "1.55",
    margin: "32px 0 0",
    paddingTop: "22px",
    borderTop: `1px solid ${BRAND.rule}`,
  },
};

/**
 * The whole frame of a system email: grey canvas, the HoundStack band, a
 * white card holding `children`, and SystemFooter below it. Every system
 * template is this plus its own words, so they cannot drift apart.
 */
export function SystemLayout({
  preview,
  note,
  children,
}: {
  preview: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: SYSTEM.canvas, fontFamily: "Arial, sans-serif", margin: 0 }}>
        <Container style={{ maxWidth: "600px", padding: "32px 16px 40px" }}>
          <SystemHeader />
          <Section
            style={{
              backgroundColor: "#ffffff",
              padding: `40px ${SYSTEM.inset} 36px`,
              border: `1px solid ${SYSTEM.cardRule}`,
              boxShadow: SYSTEM.shadow,
              borderTop: "none",
              borderRadius: `0 0 ${SYSTEM.radius} ${SYSTEM.radius}`,
            }}
          >
            {children}
          </Section>
          <SystemFooter note={note} onCanvas />
        </Container>
      </Body>
    </Html>
  );
}

/** What enqueueAppEmail reads off the organization row for the header. */
export interface TenantBrand {
  orgName?: string;
  orgLogoUrl?: string | null;
  orgBrandColor?: string | null;
}

/**
 * Top of every email sent as a business: its logo if it has one, its name if
 * not, over a stripe in its colour (HoundStack green when it has none).
 *
 * The logo's alt text is the business name, so a client that blocks images
 * still shows who the email is from.
 */
export function TenantHeader({ orgName, orgLogoUrl, orgBrandColor }: TenantBrand) {
  const name = (orgName ?? "").trim();
  const logo = safeLogoUrl(orgLogoUrl);
  if (!name && !logo) return null;
  const stripe = safeHexColor(orgBrandColor) ?? BRAND.green;
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      style={{ ...table, margin: "0 0 24px" }}
    >
      <tbody>
        <tr>
          <td style={{ borderBottom: `3px solid ${stripe}`, padding: "0 0 12px" }}>
            {logo ? (
              <img
                src={logo}
                alt={name || "Logo"}
                height={40}
                style={{
                  display: "block",
                  height: "40px",
                  width: "auto",
                  maxWidth: "200px",
                  border: 0,
                }}
              />
            ) : (
              <span style={{ fontSize: "18px", fontWeight: "bold" as const, color: "#0f172a" }}>
                {name}
              </span>
            )}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * The close of every email sent as a business, and of the weekly digest
 * (#577). The business's own name and contact lines come first (OrgFooter);
 * this follows them as its own block, left-aligned like the rest of the
 * email: a short sage rule, "Powered by HoundStack", the tagline, and the
 * same support, web and legal lines as the company signature, so the two
 * read as one family. No logo: the business's own opens the email, and a
 * second, bigger one at the bottom would compete with it.
 */
export function PoweredByHoundStack() {
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      style={{ ...table, margin: "32px 0 0" }}
    >
      <tbody>
        <tr>
          <td style={{ padding: "0 0 14px" }}>
            <SageRule />
          </td>
        </tr>
        <tr>
          <td style={{ ...small, fontFamily: ARIAL, fontSize: "13px", color: BRAND.sage }}>
            Powered by{" "}
            <a
              href={HOUNDSTACK_URL}
              style={{ color: BRAND.navy, fontWeight: "bold" as const, textDecoration: "none" }}
            >
              {APP_NAME}
            </a>
          </td>
        </tr>
        <tr>
          <td
            style={{
              fontFamily: ARIAL,
              fontSize: "12px",
              lineHeight: "17px",
              color: COMPANY.grey,
              padding: "2px 0 8px 0",
            }}
          >
            {COMPANY.tagline}
          </td>
        </tr>
        <tr>
          <td style={{ padding: 0 }}>
            <CompanyContactRows />
          </td>
        </tr>
        <tr>
          <td style={{ padding: "12px 0 0" }}>
            <CompanyLegal />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * The same header and footer as HTML strings, for platform mail that builds
 * its HTML by hand (the trial notice, announcements). Rendered from the
 * components above rather than copied, so the two cannot drift.
 */
export function systemHeaderHtml(): string {
  return renderToStaticMarkup(<SystemHeader />);
}

export function systemFooterHtml(note?: string): string {
  return renderToStaticMarkup(<SystemFooter note={note} onCanvas />);
}

/** The text/plain twin of systemFooterHtml: the note, a signature
 *  separator, and the company signature as lines. */
export function systemFooterText(note?: string): string {
  return [note ? `${note}\n` : "", "-- ", COMPANY_SIGNATURE_TEXT].join("\n").replace(/^\n/, "");
}
