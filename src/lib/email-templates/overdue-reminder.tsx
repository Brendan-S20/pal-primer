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
  daysPastDue?: number;
  invoiceUrl?: string;
}

const OverdueReminder = ({
  orgName = "your service",
  clientName = "there",
  amountCents = 0,
  daysPastDue = 0,
  invoiceUrl,
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>Friendly reminder: invoice past due</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Heading style={styles.h1}>Friendly reminder</Heading>
        <Text style={styles.text}>
          Hi {clientName}, your invoice from {orgName} is {daysPastDue} day
          {daysPastDue === 1 ? "" : "s"} past due.
        </Text>
        <Text style={styles.amount}>{fmtMoney(amountCents)}</Text>
        {invoiceUrl ? (
          <Button style={styles.button} href={invoiceUrl}>
            Pay now
          </Button>
        ) : null}
        <Text style={styles.small}>If you've already paid, please ignore this email.</Text>
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: OverdueReminder,
  subject: (d: Record<string, any>) =>
    `Past due: ${fmtMoney(d.amountCents ?? 0)} - ${d.orgName ?? "your service"}`,
  displayName: "Overdue reminder",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    amountCents: 8500,
    daysPastDue: 7,
    invoiceUrl: "https://example.com/portal/abc",
  },
} satisfies TemplateEntry;
