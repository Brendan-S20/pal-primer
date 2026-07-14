import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import { styles, fmtMoney } from "./_shared";
import type { TemplateEntry } from "./registry";

interface Props {
  orgName?: string;
  clientName?: string;
  amountCents?: number;
  paidAt?: string;
}

const PaymentReceived = ({
  orgName = "your service",
  clientName = "there",
  amountCents = 0,
  paidAt,
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>Payment received: {fmtMoney(amountCents)}</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Heading style={styles.h1}>Payment received</Heading>
        <Text style={styles.text}>Thanks {clientName}. {orgName} received your payment.</Text>
        <Text style={styles.amount}>{fmtMoney(amountCents)}</Text>
        {paidAt ? <Text style={styles.text}>Paid on {paidAt}.</Text> : null}
        <Text style={styles.small}>This email serves as your receipt.</Text>
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: PaymentReceived,
  subject: (d: Record<string, any>) => `Receipt: ${fmtMoney(d.amountCents ?? 0)} from ${d.orgName ?? "us"}`,
  displayName: "Payment received",
  previewData: { orgName: "Acme Scoop Co.", clientName: "Jane", amountCents: 8500, paidAt: "Jul 1, 2026" },
} satisfies TemplateEntry;
