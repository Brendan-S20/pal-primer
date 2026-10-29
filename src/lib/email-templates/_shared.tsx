// Shared inline styles for app email templates.
import { PoweredByHoundStack, type TenantBrand } from "./_brand";

export { TenantHeader } from "./_brand";

export const styles = {
  main: { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" },
  container: { padding: "24px 28px", maxWidth: "560px" },
  h1: {
    fontSize: "22px",
    fontWeight: "bold" as const,
    color: "#0f172a",
    margin: "0 0 16px",
  },
  text: {
    fontSize: "14px",
    color: "#334155",
    lineHeight: "1.55",
    margin: "0 0 16px",
  },
  small: { fontSize: "12px", color: "#64748b", margin: "24px 0 0" },
  button: {
    backgroundColor: "#0f172a",
    color: "#ffffff",
    fontSize: "14px",
    borderRadius: "8px",
    padding: "12px 20px",
    textDecoration: "none",
    display: "inline-block",
  },
  amount: {
    fontSize: "28px",
    fontWeight: "bold" as const,
    color: "#0f172a",
    margin: "8px 0 20px",
  },
  hr: { border: "none", borderTop: "1px solid #e2e8f0", margin: "24px 0" },
};

export function fmtMoney(cents: number | null | undefined) {
  const n = Number(cents ?? 0) / 100;
  return `$${n.toFixed(2)}`;
}

/** Every customer-facing template receives these, merged in by enqueueAppEmail
 *  from the org row. They are optional because a tenant may not have filled
 *  them in yet — the footer drops whichever lines are missing rather than
 *  printing "null". */
export interface OrgContact extends TenantBrand {
  orgName?: string;
  orgPhone?: string | null;
  orgEmail?: string | null;
  orgAddress?: string | null;
}

/**
 * Who sent this, and how to reach them.
 *
 * Before this, every template ended with its last sentence. A customer
 * reading "Your yard cleanup is complete" had no phone number, no address,
 * and no indication that replying would reach a human — and `contact_phone`
 * and `contact_email` had been sitting on the organization row, editable in
 * Settings, used by other parts of the product, and never once put in an
 * email.
 *
 * Rendered as a table rather than flex/grid: this is email, and Outlook is
 * still Outlook. Every contact line is independently optional. The line
 * after them is not: mail sent as a business always ends "Powered by
 * HoundStack" (#577).
 */
export function OrgFooter(props: OrgContact) {
  return (
    <>
      <OrgContactLines {...props} />
      <PoweredByHoundStack />
    </>
  );
}

function OrgContactLines({ orgName, orgPhone, orgEmail, orgAddress }: OrgContact) {
  const phone = (orgPhone ?? "").trim();
  const email = (orgEmail ?? "").trim();
  const address = (orgAddress ?? "").trim();
  const name = (orgName ?? "").trim();
  if (!name && !phone && !email && !address) return null;
  return (
    <>
      <hr style={styles.hr} />
      <table role="presentation" cellPadding={0} cellSpacing={0} style={{ width: "100%" }}>
        <tbody>
          {name ? (
            <tr>
              <td style={{ ...styles.small, margin: 0, fontWeight: "bold" as const }}>{name}</td>
            </tr>
          ) : null}
          {phone ? (
            <tr>
              <td style={{ ...styles.small, margin: 0 }}>
                <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} style={{ color: "#64748b" }}>
                  {phone}
                </a>
              </td>
            </tr>
          ) : null}
          {email ? (
            <tr>
              <td style={{ ...styles.small, margin: 0 }}>
                <a href={`mailto:${email}`} style={{ color: "#64748b" }}>
                  {email}
                </a>
              </td>
            </tr>
          ) : null}
          {address ? (
            <tr>
              <td style={{ ...styles.small, margin: 0 }}>{address}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </>
  );
}
