import * as React from "react";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from "@react-email/components";
import { styles, fmtMoney, OrgFooter, type OrgContact, TenantHeader } from "./_shared";
import type { TemplateEntry } from "./registry";

// The card on file was declined on an automatic charge.
//
// Until 2026-10-06 the client heard about this by text, from the platform's
// number. A business's clients are now texted only from the business's own
// number, which no business has yet, so for a while the client heard nothing
// at all: autopay failed, the office got an in-app notice, and the person who
// could fix it was not told. This is that notice, by email.
//
// What it deliberately leaves out: the decline reason and every card detail.
// A decline code ("do_not_honor", "insufficient_funds") is between the client
// and their bank, read wrongly it is alarming, and the receipt emails show no
// card details either, so this does not start.

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  /** "INV-1042", the label every screen and email uses (invoiceRef). */
  invoiceNumber?: string;
  /** What was being charged toward the invoice. */
  amountCents?: number;
  /** The client's portal, where they update the card or pay the invoice.
   *  The same link the overdue reminder carries. */
  portalUrl?: string;
}

const PaymentFailed = ({
  orgName = "your service",
  clientName = "there",
  invoiceNumber,
  amountCents = 0,
  portalUrl,
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>Your card on file was declined</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <TenantHeader {...orgContact} orgName={orgName} />
        <Heading style={styles.h1}>Your card was declined</Heading>
        <Text style={styles.text}>
          Hi {clientName}, {orgName} tried to charge the card you have on file for
          {invoiceNumber ? ` invoice ${invoiceNumber}` : " your invoice"}, and the card was
          declined. Nothing has been charged.
        </Text>
        <Text style={styles.amount}>{fmtMoney(amountCents)}</Text>
        <Text style={styles.text}>
          This happens for everyday reasons, like a new card or a changed expiry date. You can
          update your card or pay the invoice in your account.
        </Text>
        {portalUrl ? (
          <Button style={styles.button} href={portalUrl}>
            Update card or pay
          </Button>
        ) : null}
        <Text style={styles.small}>
          If you&apos;ve already sorted this out, you can ignore this email. Questions? Get in touch
          with {orgName} using the details below.
        </Text>
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: PaymentFailed,
  subject: (d: Record<string, any>) =>
    d.invoiceNumber
      ? `Your card was declined for invoice ${d.invoiceNumber} from ${d.orgName ?? "us"}`
      : `Your card was declined: ${d.orgName ?? "your service"}`,
  displayName: "Card declined",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    invoiceNumber: "INV-1042",
    amountCents: 8500,
    portalUrl: "https://example.com/portal/acme/abc",
    orgPhone: "(555) 010-2000",
    orgEmail: "office@acmescoop.example",
  },
} satisfies TemplateEntry;
