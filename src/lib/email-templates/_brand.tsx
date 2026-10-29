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
import { APP_NAME } from "@/lib/scoop";

export const HOUNDSTACK_URL = "https://houndstack.com";

/** The app's --brand and --brand-ink tokens (styles.css), as hex. Email
 *  clients do not read oklch. */
export const BRAND = {
  green: "#267b4c",
  ink: "#09311b",
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

/** Top of every system email: the HoundStack wordmark on its own band. */
export function SystemHeader() {
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      style={{ ...table, margin: "0 0 24px" }}
    >
      <tbody>
        <tr>
          <td
            style={{
              backgroundColor: BRAND.ink,
              borderTop: `4px solid ${BRAND.green}`,
              padding: "14px 20px",
            }}
          >
            <a
              href={HOUNDSTACK_URL}
              style={{
                color: "#ffffff",
                fontSize: "18px",
                fontWeight: "bold" as const,
                letterSpacing: "0.2px",
                textDecoration: "none",
              }}
            >
              {APP_NAME}
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
 *  weekly digest): the HoundStack line then reads "Powered by HoundStack". */
export function SystemFooter({ note, poweredBy }: { note?: React.ReactNode; poweredBy?: boolean }) {
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
            style={{ ...small, padding: "12px 0 0", fontWeight: "bold" as const, color: BRAND.ink }}
          >
            {poweredBy ? (
              <>
                Powered by{" "}
                <a href={HOUNDSTACK_URL} style={{ color: BRAND.green }}>
                  {APP_NAME}
                </a>
              </>
            ) : (
              APP_NAME
            )}
          </td>
        </tr>
        <tr>
          <td style={{ ...small, padding: "2px 0 0" }}>{OPERATOR_LINE}</td>
        </tr>
      </tbody>
    </table>
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

/** Last line of every email sent as a business. */
export function PoweredByHoundStack() {
  return (
    <table
      role="presentation"
      cellPadding={0}
      cellSpacing={0}
      style={{ ...table, margin: "20px 0 0" }}
    >
      <tbody>
        <tr>
          <td style={{ ...small, fontSize: "11px" }}>
            Powered by{" "}
            <a href={HOUNDSTACK_URL} style={{ color: BRAND.green, fontWeight: "bold" as const }}>
              {APP_NAME}
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
