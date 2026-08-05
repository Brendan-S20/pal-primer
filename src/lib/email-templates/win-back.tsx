import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text, Button } from "@react-email/components";
import { styles } from "./_shared";
import type { TemplateEntry } from "./registry";

interface Props {
  orgName?: string;
  clientName?: string;
  /**
   * A pre-formatted dollar string ("$15"), not a percentage.
   *
   * This was `discountPercent`, and the copy read "20% off your next month of
   * service". Nothing in the product applies a percentage — the promo code the
   * sender created alongside this email credited a flat amount or, in the case
   * of win-back, failed to be created at all. The email was the only place the
   * offer existed. It now states the amount the code is actually worth.
   */
  discountAmount?: string;
  promoCode?: string;
  expiresOn?: string;
  portalUrl?: string;
}

const WinBack = ({
  orgName = "your service",
  clientName = "there",
  discountAmount = "$15",
  promoCode = "COMEBACK",
  expiresOn,
  portalUrl,
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>{`We miss you at ${orgName}: ${discountAmount} off to come back`}</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Heading style={styles.h1}>We miss you, {clientName}</Heading>
        <Text style={styles.text}>
          It's been a while since we've seen you at {orgName}. We'd love to have you back. Here's
          {" "}{discountAmount} of credit toward your next service.
        </Text>
        <Text style={{ ...styles.amount, fontSize: 22 }}>Code: <strong>{promoCode}</strong></Text>
        <Text style={styles.small}>
          Enter it under Billing in your customer portal and the credit is applied to your account.
        </Text>
        {expiresOn && (
          <Text style={styles.small}>Offer valid through {expiresOn}.</Text>
        )}
        {portalUrl && (
          <Button style={styles.button} href={portalUrl}>Reactivate service</Button>
        )}
        <Text style={styles.small}>
          If you had an issue with your service, just reply to this email. We'd like to make it right.
        </Text>
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: WinBack,
  subject: (d: Record<string, any>) =>
    `We miss you: ${d.discountAmount ?? "$15"} off from ${d.orgName ?? "us"}`,
  displayName: "Win-back",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    discountAmount: "$15",
    promoCode: "COMEBACK15",
    expiresOn: "Aug 4",
    portalUrl: "https://example.com/portal/abc",
  },
} satisfies TemplateEntry;
