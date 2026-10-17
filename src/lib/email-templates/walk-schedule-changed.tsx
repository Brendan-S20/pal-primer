import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import { styles, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";
import type { WalkScheduleLine } from "@/lib/walk-notify";

// The office moved a dog walk, or changed a walk plan's days or window
// (#410). One email per client per action, with each change as before and
// after. Dog walking only (src/lib/walk-notify.server.ts).

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  changes?: WalkScheduleLine[];
  /** Changes past the ones listed, for a large move. */
  moreCount?: number;
}

const WalkScheduleChanged = ({
  orgName = "your walker",
  clientName = "there",
  changes = [],
  moreCount = 0,
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>Your walk schedule changed</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Heading style={styles.h1}>Your walk schedule changed</Heading>
        <Text style={styles.text}>Hi {clientName}, {orgName} changed your walk schedule.</Text>
        {changes.map((c, i) => (
          <Text key={i} style={styles.text}>
            Was: {c.before}
            <br />
            Now: <strong>{c.after}</strong>
          </Text>
        ))}
        {moreCount > 0 ? (
          <Text style={styles.small}>
            {moreCount === 1 ? "One more walk moved too." : `${moreCount} more walks moved too.`}
          </Text>
        ) : null}
        <Text style={styles.text}>If that does not work for you, reply to this email.</Text>
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: WalkScheduleChanged,
  subject: "Your walk schedule changed",
  displayName: "Walk schedule changed",
  previewData: {
    orgName: "Acme Dog Walking",
    clientName: "Jane",
    changes: [{ before: "Mon, Oct 19, 10 AM to 12 PM", after: "Tue, Oct 20, 10 AM to 12 PM" }],
    moreCount: 0,
  },
} satisfies TemplateEntry;
