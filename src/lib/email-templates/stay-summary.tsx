import * as React from "react";
import { Body, Button, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import { styles, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";
import { staySummaryCount, staySummarySubject, type StaySummaryEmail } from "@/lib/sit-report";

// The last visit of a pet sitting stay is done (#411): the dates, how many
// visits there were, any medication missed along the way, and a link to every
// visit report in the portal. Once per stay (src/lib/sit-report.server.ts).

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  pets?: StaySummaryEmail["pets"];
  dates?: StaySummaryEmail["dates"];
  visitsDone?: StaySummaryEmail["visitsDone"];
  visitsTotal?: StaySummaryEmail["visitsTotal"];
  overnight?: StaySummaryEmail["overnight"];
  missed?: StaySummaryEmail["missed"];
  portalUrl?: StaySummaryEmail["portalUrl"];
}

const StaySummary = ({
  orgName = "your sitter",
  clientName = "there",
  pets = "your pets",
  dates = "",
  visitsDone = 0,
  visitsTotal = 0,
  overnight = false,
  missed = [],
  portalUrl,
  ...orgContact
}: Props) => {
  const subject = staySummarySubject(pets);
  return (
    <Html lang="en">
      <Head />
      <Preview>{subject}</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Heading style={styles.h1}>{subject}</Heading>
          <Text style={styles.text}>
            {`Hi ${clientName}, ${orgName} has finished looking after ${pets}. Welcome home.`}
          </Text>
          {dates ? <Text style={styles.text}>{dates}</Text> : null}
          {visitsTotal > 0 ? (
            <Text style={styles.text}>
              {`${staySummaryCount({ visitsDone, visitsTotal, overnight })} done.`}
            </Text>
          ) : null}
          {missed.length > 0 ? (
            <>
              <Text style={styles.text}>Medications that were not given:</Text>
              {missed.map((m, i) => (
                <Text key={i} style={{ ...styles.text, margin: "2px 0" }}>
                  {`${m.day}, ${m.pet}: ${m.med}. ${m.reason}`}
                </Text>
              ))}
            </>
          ) : (
            <Text style={styles.text}>Every medication was given.</Text>
          )}
          {portalUrl ? (
            <Button href={portalUrl} style={styles.button}>
              See every visit report
            </Button>
          ) : null}
          <OrgFooter {...orgContact} orgName={orgName} />
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: StaySummary,
  subject: (d: Record<string, any>) => staySummarySubject(d.pets ?? "your pets"),
  displayName: "Stay summary",
  previewData: {
    orgName: "Acme Pet Sitting",
    clientName: "Jane",
    pets: "Luna and Max",
    dates: "Check-in Oct 19, check-out Oct 24",
    visitsDone: 5,
    visitsTotal: 5,
    overnight: true,
    missed: [],
    portalUrl: "https://example.com/portal/acme/token/visits",
  },
} satisfies TemplateEntry;
