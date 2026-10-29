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
} from "@react-email/components";
import { styles, fmtMoney, OrgFooter, type OrgContact, TenantHeader } from "./_shared";
import type { TemplateEntry } from "./registry";

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
        {invoiceUrl ? (
          <Button style={styles.button} href={invoiceUrl}>
            View &amp; pay invoice
          </Button>
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
    `${d.reminder ? "Reminder: invoice" : "Invoice"} ${fmtMoney(
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
  },
} satisfies TemplateEntry;
