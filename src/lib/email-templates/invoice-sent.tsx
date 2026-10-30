import * as React from "react";
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
  Button,
  Link,
  Section,
  Row,
  Column,
} from "@react-email/components";
import { styles, fmtMoney, OrgFooter, type OrgContact, TenantHeader } from "./_shared";
import type { TemplateEntry } from "./registry";
import type { InvoiceEmailLine } from "@/lib/invoice-email-details";

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  amountCents?: number;
  invoiceUrl?: string;
  periodLabel?: string;
  /** Reminder re-send of an already-sent invoice (QA round 8). */
  reminder?: boolean;
  /** Sales tax inside amountCents, and the subtotal it was charged on. The
   *  sentence below the amount is drawn only when taxCents > 0, so an email
   *  for an untaxed invoice reads exactly as it always did. */
  subtotalCents?: number;
  taxCents?: number;
  /** "Sales tax (8.25%)". */
  taxLabel?: string;
  /** Partly paid: what has been paid, and the balance still due. Sent only
   *  when something was paid, so every other email is unchanged. */
  amountPaidCents?: number;
  balanceCents?: number;
  /** The portal's card form (buildPortalCardLink). Sent only when the client
   *  has no card on file, so a client who already saved one is not asked
   *  again and every other email reads as it always did. */
  cardUrl?: string;
  /** "INV-1001", the due date, and what the invoice is for (#607). From
   *  invoiceEmailDetails. Each is optional so a message queued before this
   *  existed still renders. */
  invoiceLabel?: string;
  dueLabel?: string;
  lines?: InvoiceEmailLine[];
  moreLines?: number;
}

const lineStyles = {
  section: { margin: "0 0 20px", borderTop: "1px solid #e2e8f0" },
  row: { borderBottom: "1px solid #e2e8f0" },
  description: { fontSize: "14px", color: "#334155", padding: "8px 8px 8px 0" },
  detail: { fontSize: "12px", color: "#64748b" },
  amount: {
    fontSize: "14px",
    color: "#0f172a",
    padding: "8px 0",
    textAlign: "right" as const,
    whiteSpace: "nowrap" as const,
    verticalAlign: "top" as const,
  },
};

/** "INV-1001 · due Nov 14, 2026". */
export function invoiceHeadline(invoiceLabel?: string, dueLabel?: string): string {
  if (!invoiceLabel) return dueLabel ? `Due ${dueLabel}` : "";
  return dueLabel ? `${invoiceLabel} · due ${dueLabel}` : invoiceLabel;
}

const InvoiceSent = ({
  orgName = "your service",
  clientName = "there",
  amountCents = 0,
  invoiceUrl,
  periodLabel,
  reminder = false,
  subtotalCents,
  taxCents = 0,
  taxLabel,
  amountPaidCents = 0,
  balanceCents,
  cardUrl,
  invoiceLabel,
  dueLabel,
  lines = [],
  moreLines = 0,
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>
      {reminder
        ? `Reminder: invoice from ${orgName}: ${fmtMoney(amountCents)}`
        : `New invoice from ${orgName}: ${fmtMoney(amountCents)}`}
    </Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <TenantHeader {...orgContact} orgName={orgName} />
        <Heading style={styles.h1}>{reminder ? "Invoice reminder" : "New invoice"}</Heading>
        <Text style={styles.text}>
          {reminder
            ? `Hi ${clientName}, a friendly reminder that your invoice from ${orgName} is still open.`
            : `Hi ${clientName}, a new invoice from ${orgName} is ready.`}
        </Text>
        {invoiceHeadline(invoiceLabel, dueLabel) ? (
          <Text style={{ ...styles.text, margin: "0 0 4px", fontWeight: "bold" }}>
            {invoiceHeadline(invoiceLabel, dueLabel)}
          </Text>
        ) : null}
        <Text style={styles.amount}>{fmtMoney(amountCents)}</Text>
        {taxCents > 0 ? (
          <Text style={styles.small}>
            {subtotalCents != null ? `${fmtMoney(subtotalCents)} plus ` : "Includes "}
            {fmtMoney(taxCents)} {taxLabel || "sales tax"}
          </Text>
        ) : null}
        {amountPaidCents > 0 && balanceCents != null ? (
          <Text style={styles.text}>
            {fmtMoney(amountPaidCents)} already paid. {fmtMoney(balanceCents)} is still due.
          </Text>
        ) : null}
        {periodLabel ? <Text style={styles.text}>{periodLabel}</Text> : null}
        {lines.length > 0 ? (
          <Section style={lineStyles.section}>
            {lines.map((l, i) => (
              <Row key={i} style={lineStyles.row}>
                <Column style={lineStyles.description}>
                  {l.description}
                  {l.quantity !== 1 && l.unitAmountCents != null ? (
                    <span style={lineStyles.detail}>
                      {" "}
                      ({l.quantity} × {fmtMoney(l.unitAmountCents)})
                    </span>
                  ) : null}
                </Column>
                <Column style={lineStyles.amount}>{fmtMoney(l.amountCents)}</Column>
              </Row>
            ))}
            {moreLines > 0 ? (
              <Text style={{ ...styles.small, margin: "8px 0 0" }}>
                {`and ${moreLines} more ${moreLines === 1 ? "line" : "lines"} on the invoice`}
              </Text>
            ) : null}
          </Section>
        ) : null}
        {invoiceUrl ? (
          <Button style={styles.button} href={invoiceUrl}>
            View &amp; pay invoice
          </Button>
        ) : null}
        {cardUrl ? (
          <Text style={styles.small}>
            Want to skip this step next time?{" "}
            <Link href={cardUrl}>Save a card in your account</Link> and pay future invoices in one
            tap.
          </Text>
        ) : null}
        <Text style={styles.small}>
          {reminder
            ? "If you've already paid, please ignore this email."
            : "Thanks for your business."}
        </Text>
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: InvoiceSent,
  subject: (d: Record<string, any>) =>
    `${d.reminder ? "Reminder: invoice" : "Invoice"}${d.invoiceLabel ? ` ${d.invoiceLabel}` : ""} ${fmtMoney(
      (d.amountPaidCents ?? 0) > 0 && d.balanceCents != null
        ? d.balanceCents
        : (d.amountCents ?? 0),
    )} from ${d.orgName ?? "your service"}`,
  displayName: "Invoice sent",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    amountCents: 8500,
    invoiceUrl: "https://example.com/portal/abc",
    periodLabel: "Services from Jun 1 to Jun 30",
    invoiceLabel: "INV-1001",
    dueLabel: "Jul 15, 2026",
    lines: [
      { description: "Weekly cleanup", quantity: 4, unitAmountCents: 2000, amountCents: 8000 },
      { description: "Gate fee", quantity: 1, unitAmountCents: null, amountCents: 500 },
    ],
    cardUrl: "https://example.com/portal/acme/abc/billing?card=update",
  },
} satisfies TemplateEntry;
