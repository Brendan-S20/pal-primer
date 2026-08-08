import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import { styles, fmtMoney, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  /** The invoice amount — NOT necessarily what the card was charged. */
  amountCents?: number;
  /** Card processing passed through to the payer, when the org does that. */
  surchargeCents?: number;
  paidAt?: string;
}

/** What actually hit the card. This is the number the receipt has to lead
 *  with: a receipt that quotes the invoice amount while the statement shows
 *  more is a receipt the customer cannot reconcile. */
const charged = (amountCents: number, surchargeCents: number) => amountCents + surchargeCents;

const PaymentReceived = ({
  orgName = "your service",
  clientName = "there",
  amountCents = 0,
  surchargeCents = 0,
  paidAt,
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>Payment received: {fmtMoney(charged(amountCents, surchargeCents))}</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Heading style={styles.h1}>Payment received</Heading>
        <Text style={styles.text}>
          Thanks {clientName}. {orgName} received your payment.
        </Text>
        <Text style={styles.amount}>{fmtMoney(charged(amountCents, surchargeCents))}</Text>
        {surchargeCents > 0 ? (
          <Text style={styles.small}>
            {fmtMoney(amountCents)} for service + {fmtMoney(surchargeCents)} card processing.
          </Text>
        ) : null}
        {paidAt ? <Text style={styles.text}>Paid on {paidAt}.</Text> : null}
        <Text style={styles.small}>This email serves as your receipt.</Text>
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: PaymentReceived,
  subject: (d: Record<string, any>) =>
    `Receipt: ${fmtMoney(charged(d.amountCents ?? 0, d.surchargeCents ?? 0))} from ${d.orgName ?? "us"}`,
  displayName: "Payment received",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    amountCents: 4575,
    surchargeCents: 138,
    paidAt: "Jul 1, 2026",
  },
} satisfies TemplateEntry;
