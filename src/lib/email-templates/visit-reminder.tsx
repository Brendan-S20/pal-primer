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
import {
  styles,
  OrgFooter,
  type OrgContact,
  TenantHeader,
  howToReach,
  cap,
  sentence,
} from "./_shared";
import type { TemplateEntry } from "./registry";

// The day-before reminder, sent by the nightly job. One email per client per
// day, listing every property visited that day, so a client with a house and
// a rental does not get two.

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  /** "Tuesday, September 29", already on the org's calendar. */
  dayLabel?: string;
  addresses?: string[];
  /** The client's portal, where they can skip or reschedule. */
  portalUrl?: string;
}

const VisitReminder = ({
  orgName = "your service",
  clientName = "there",
  dayLabel = "tomorrow",
  addresses = [],
  portalUrl,
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>{`Your visit from ${orgName} is tomorrow, ${dayLabel}`}</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <TenantHeader {...orgContact} orgName={orgName} />
        <Heading style={styles.h1}>Your visit is tomorrow</Heading>
        <Text style={styles.text}>
          Hi {clientName}, this is a reminder that {orgName} is scheduled to visit on{" "}
          <strong>{dayLabel}</strong>
          {addresses.length === 1 ? (
            <>
              {" "}
              at <strong>{addresses[0]}</strong>.
            </>
          ) : (
            "."
          )}
        </Text>
        {addresses.length > 1 && (
          <Text style={styles.text}>
            {addresses.map((a) => (
              <React.Fragment key={a}>
                {a}
                <br />
              </React.Fragment>
            ))}
          </Text>
        )}
        {portalUrl ? (
          <>
            <Text style={styles.text}>Need to skip it or move it? You can do that yourself:</Text>
            <Button href={portalUrl} style={styles.button}>
              Manage my visit
            </Button>
          </>
        ) : (
          <Text style={styles.text}>
            Need to skip it or move it? {sentence(cap(howToReach({ ...orgContact, orgName })))}
          </Text>
        )}
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: VisitReminder,
  subject: (d: Record<string, any>) =>
    `Reminder: your visit is tomorrow, ${d.dayLabel ?? ""}`.trim(),
  displayName: "Day-before visit reminder",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    dayLabel: "Tuesday, September 29",
    addresses: ["412 Elm St, Austin"],
    portalUrl: "https://example.com/portal/acme/abc123",
  },
} satisfies TemplateEntry;
