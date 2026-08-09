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
import { styles, fmtMoney, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  amountCents?: number;
  invoiceUrl?: string;
  periodLabel?: string;
  /** Reminder re-send of an already-sent invoice (QA round 8). */
  reminder?: boolean;
}

const InvoiceSent = ({
  orgName = "your service",
  clientName = "there",
  amountCents = 0,
  invoiceUrl,
  periodLabel,
  reminder = false,
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
        <Heading style={styles.h1}>{reminder ? "Invoice reminder" : "New invoice"}</Heading>
        <Text style={styles.text}>
          {reminder
            ? `Hi ${clientName}, a friendly reminder that your invoice from ${orgName} is still open.`
            : `Hi ${clientName}, a new invoice from ${orgName} is ready.`}
        </Text>
        <Text style={styles.amount}>{fmtMoney(amountCents)}</Text>
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
    `${d.reminder ? "Reminder: invoice" : "Invoice"} ${fmtMoney(d.amountCents ?? 0)} from ${d.orgName ?? "your service"}`,
  displayName: "Invoice sent",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    amountCents: 8500,
    invoiceUrl: "https://example.com/portal/abc",
    periodLabel: "Services from Jun 1 to Jun 30",
  },
} satisfies TemplateEntry;
