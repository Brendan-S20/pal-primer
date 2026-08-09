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
import { styles, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";

interface Props extends OrgContact {
  siteName?: string;
  orgName?: string;
  clientName?: string;
  portalUrl?: string;
}

const WelcomeEmail = ({
  orgName = "your service",
  clientName = "there",
  portalUrl,
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>Welcome to {orgName}</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Heading style={styles.h1}>Welcome, {clientName}!</Heading>
        <Text style={styles.text}>
          Thanks for choosing {orgName}. We're set up and ready to keep your yard clean.
        </Text>
        {portalUrl ? (
          <>
            <Text style={styles.text}>
              Use your private portal link to see upcoming visits, invoices, and manage your
              service:
            </Text>
            <Button style={styles.button} href={portalUrl}>
              Open my portal
            </Button>
          </>
        ) : null}
        <Text style={styles.small}>Reply to this email if you have questions.</Text>
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: WelcomeEmail,
  subject: (d: Record<string, any>) => `Welcome to ${d.orgName ?? "our service"}`,
  displayName: "Welcome",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    portalUrl: "https://example.com/portal/abc",
  },
} satisfies TemplateEntry;
