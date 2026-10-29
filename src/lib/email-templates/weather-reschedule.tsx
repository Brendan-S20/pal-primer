import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import { styles, OrgFooter, type OrgContact, TenantHeader } from "./_shared";
import type { TemplateEntry } from "./registry";

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  originalDate?: string;
  newDate?: string;
  reason?: string;
}

const WeatherReschedule = ({
  orgName = "your service",
  clientName = "there",
  originalDate = "",
  newDate = "",
  reason,
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>Your visit has been rescheduled due to weather</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <TenantHeader {...orgContact} orgName={orgName} />
        <Heading style={styles.h1}>Visit rescheduled</Heading>
        <Text style={styles.text}>
          Hi {clientName}, due to weather{reason ? ` (${reason})` : ""} we're moving your visit from{" "}
          <strong>{originalDate}</strong> to <strong>{newDate}</strong>.
        </Text>
        <Text style={styles.text}>No action needed on your end. {orgName} will be there.</Text>
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: WeatherReschedule,
  subject: (d: Record<string, any>) => `Visit moved to ${d.newDate ?? "a new date"} (weather)`,
  displayName: "Weather reschedule",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    originalDate: "Jul 1",
    newDate: "Jul 3",
    reason: "Heavy rain forecast",
  },
} satisfies TemplateEntry;
