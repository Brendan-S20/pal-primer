// Brand chrome for every email the product sends (#577).
//
// Three kinds of mail, two kinds of chrome:
//
// - System mail (sign-in links, recovery, email change, team invites, the
//   weekly digest) comes from HoundStack. It opens with the HoundStack band
//   and closes with SystemFooter, which names The North Consulting LLC as
//   the operator in the same words as the public site and the carrier filing.
// - Tenant mail (invoices, visit notes, reminders, campaigns) is sent AS the
//   business. It opens with that business's logo, or its name, over a stripe
//   in its brand colour, and closes with OrgFooter, whose last line is
//   "Powered by HoundStack".
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

/** Word for word with OperatorIdentity in PublicFooter.tsx, which has to match
 *  the toll-free filing. Kept here as a copy because email cannot import a
 *  component that renders Tailwind classes. */
export const OPERATOR_LINE = `${APP_NAME} is operated by The North Consulting LLC, 2222 West Grand River Avenue STE A, Okemos, MI 48864.`;

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

/** Bottom of every system email. `note` is the email's own last line (why
 *  it was sent, how to stop it), printed above the operator line.
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
  if (poweredBy) {
    // The weekly digest: system mail about a business. Its note, then the
    // same close tenant mail ends with.
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
          </tbody>
        </table>
        <PoweredByHoundStack />
      </>
    );
  }
  return (
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
        <tr>
          <td
            style={{
              ...small,
              padding: "12px 0 0",
              fontWeight: "bold" as const,
              color: BRAND.navy,
            }}
          >
            {APP_NAME}
          </td>
        </tr>
        <tr>
          <td style={{ ...small, padding: "2px 0 0" }}>{OPERATOR_LINE}</td>
        </tr>
      </tbody>
    </table>
  );
}

const footerLink = { color: BRAND.navy, textDecoration: "none", fontWeight: "bold" as const };

/** The short sage rule that opens every HoundStack close, system or tenant. */
function SageRule({ centred }: { centred?: boolean }) {
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      style={centred ? { margin: "0 auto" } : { margin: 0 }}
    >
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

/** Where to reach HoundStack. */
function ReachLinks() {
  return (
    <>
      <a href={HOUNDSTACK_URL} style={footerLink}>
        houndstack.com
      </a>
      {"  ·  "}
      <a href={`mailto:${SUPPORT_EMAIL}`} style={footerLink}>
        {SUPPORT_EMAIL}
      </a>
    </>
  );
}

/** The footer under a system email's card: the email's own note, a short
 *  sage rule, the HoundStack name, the operator line and where to reach
 *  HoundStack, centred on the canvas. */
function CanvasFooter({ note }: { note?: React.ReactNode }) {
  const centred = { ...small, textAlign: "center" as const };
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
            <td style={{ ...centred, padding: `0 ${SYSTEM.inset} 20px`, color: "#475569" }}>
              {note}
            </td>
          </tr>
        ) : null}
        <tr>
          <td align="center" style={{ padding: "0 0 16px" }}>
            <SageRule centred />
          </td>
        </tr>
        <tr>
          <td
            style={{ ...centred, fontSize: "13px", fontWeight: "bold" as const, color: BRAND.navy }}
          >
            {APP_NAME}
          </td>
        </tr>
        <tr>
          <td style={{ ...centred, padding: `4px ${SYSTEM.inset} 0` }}>{OPERATOR_LINE}</td>
        </tr>
        <tr>
          <td style={{ ...centred, padding: "10px 0 0" }}>
            <ReachLinks />
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
 * email: a short sage rule, "Powered by HoundStack", the operator line, and
 * where to reach HoundStack. The same pieces, in the same order, as the
 * footer under system mail, so the two read as one family.
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
          <td style={{ ...small, fontSize: "13px", color: BRAND.sage }}>
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
          <td style={{ ...small, padding: "4px 0 0" }}>{OPERATOR_LINE}</td>
        </tr>
        <tr>
          <td style={{ ...small, padding: "8px 0 0" }}>
            <ReachLinks />
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
