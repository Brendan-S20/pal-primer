import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text, Button } from "@react-email/components";
import { styles } from "./_shared";
import type { TemplateEntry } from "./registry";

interface Props {
  orgName?: string;
  clientName?: string;
  discountPercent?: number;
  promoCode?: string;
  expiresOn?: string;
  portalUrl?: string;
}

const WinBack = ({
  orgName = "your service",
  clientName = "there",
  discountPercent = 20,
  promoCode = "COMEBACK",
  expiresOn,
  portalUrl,
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>{`We miss you at ${orgName}: ${discountPercent}% off to come back`}</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Heading style={styles.h1}>We miss you, {clientName}</Heading>
        <Text style={styles.text}>
          It's been a while since we've seen you at {orgName}. We'd love to have you back. Here's
          {" "}{discountPercent}% off your next month of service.
        </Text>
        <Text style={{ ...styles.amount, fontSize: 22 }}>Code: <strong>{promoCode}</strong></Text>
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
  subject: (d: Record<string, any>) => `We miss you: ${d.discountPercent ?? 20}% off from ${d.orgName ?? "us"}`,
  displayName: "Win-back",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    discountPercent: 20,
    promoCode: "COMEBACK20",
    expiresOn: "Aug 4",
    portalUrl: "https://example.com/portal/abc",
  },
} satisfies TemplateEntry;
