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
import {
  styles,
  OrgFooter,
  type OrgContact,
  TenantHeader,
  howToReach,
  cap,
  noEndPeriod,
} from "./_shared";
import type { TemplateEntry } from "./registry";

interface Props extends OrgContact {
  siteName?: string;
  orgName?: string;
  clientName?: string;
  portalUrl?: string;
  /** "Monday, November 2": the day a booking-link signup's first visit is
   *  on or after (#527). Absent for a client the office added. */
  firstVisitDate?: string;
  /** "Tuesday, November 3 at 9:30 AM": a groom booked and paid for on the
   *  booking link (#560). Said instead of firstVisitDate: the time is booked,
   *  not waiting to be confirmed. */
  bookedGroom?: string;
}

const WelcomeEmail = ({
  orgName = "your service",
  clientName = "there",
  portalUrl,
  firstVisitDate,
  bookedGroom,
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>Welcome to {orgName}</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <TenantHeader {...orgContact} orgName={orgName} />
        <Heading style={styles.h1}>Welcome, {clientName}!</Heading>
        <Text style={styles.text}>
          Thanks for choosing {noEndPeriod(orgName)}. We're set up and looking forward to your first
          visit.
        </Text>
        {bookedGroom ? (
          <Text style={styles.text}>Your first groom is booked for {bookedGroom}.</Text>
        ) : firstVisitDate ? (
          <Text style={styles.text}>
            {orgName} will confirm your first visit for on or after {firstVisitDate}.
          </Text>
        ) : null}
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
        <Text style={styles.small}>
          {cap(howToReach({ ...orgContact, orgName }))} if you have questions.
        </Text>
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
    firstVisitDate: "Monday, November 2",
  },
} satisfies TemplateEntry;
