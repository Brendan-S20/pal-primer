import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import { styles, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";
import { missedMedsSubject, type MissedMed } from "@/lib/sit-report";

// A pet sitting visit ended with a medication not given (#411), sent once per
// visit with each one and the sitter's reason. Pet sitting visits only, under
// the business's "Missed medication" switch (src/lib/sit-report.server.ts).

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  /** "Luna", "Luna and Max", or "your pets". */
  pets?: string;
  /** "Mon, Oct 19". */
  day?: string;
  missed?: MissedMed[];
}

const SitMissedMeds = ({
  orgName = "your sitter",
  clientName = "there",
  pets = "your pets",
  day = "",
  missed = [],
  ...orgContact
}: Props) => {
  const subject = missedMedsSubject(pets);
  return (
    <Html lang="en">
      <Head />
      <Preview>{subject}</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Heading style={styles.h1}>{subject}</Heading>
          <Text style={styles.text}>
            Hi {clientName}, at {day ? `the visit on ${day}` : "today's visit"} the sitter could not
            give {missed.length === 1 ? "this medication" : "these medications"}:
          </Text>
          {missed.map((m, i) => (
            <Text key={i} style={{ ...styles.text, margin: "2px 0" }}>
              {`${m.pet}: ${m.med}. ${m.reason}`}
            </Text>
          ))}
          <Text style={styles.text}>
            {orgName} has been told. If there is something we should do, reply to this email.
          </Text>
          <OrgFooter {...orgContact} orgName={orgName} />
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: SitMissedMeds,
  subject: (d: Record<string, any>) => missedMedsSubject(d.pets ?? "your pets"),
  displayName: "Missed medication",
  previewData: {
    orgName: "Acme Pet Sitting",
    clientName: "Jane",
    pets: "Luna",
    day: "Mon, Oct 19",
    missed: [{ pet: "Luna", med: "Insulin", reason: "She would not come out from under the bed." }],
  },
} satisfies TemplateEntry;
