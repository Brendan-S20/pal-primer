import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import { styles, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";

// "On my way", for a customer who cannot be texted: no consent on file yet,
// no sender, or the carrier refused it. Sent when the tech taps Navigate or
// the on-my-way button.

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  /** The tech's first name, or absent. */
  techName?: string;
  /** "between 10:15 AM and 10:45 AM", already on the org's clock, or absent. */
  eta?: string;
  address?: string;
}

const OnMyWay = ({
  orgName = "your service",
  clientName = "there",
  techName,
  eta,
  address,
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>{`${techName ?? "Your tech"} is on the way${eta ? `, arriving ${eta}` : ""}`}</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Heading style={styles.h1}>On the way</Heading>
        <Text style={styles.text}>
          Hi {clientName}, {techName ? `${techName} from ${orgName}` : `your ${orgName} tech`} is on
          the way for today&apos;s visit
          {address ? (
            <>
              {" "}
              at <strong>{address}</strong>
            </>
          ) : null}
          {eta ? (
            <>
              , arriving <strong>{eta}</strong>
            </>
          ) : null}
          .
        </Text>
        <Text style={styles.text}>
          If there is a dog out in the yard, or anything the tech should know, reply to this email.
        </Text>
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: OnMyWay,
  subject: (d: Record<string, any>) =>
    `${d.techName ?? "Your tech"} is on the way${d.eta ? `, arriving ${d.eta}` : ""}`,
  displayName: "On my way",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    techName: "Sam",
    eta: "between 10:15 AM and 10:45 AM",
    address: "412 Elm St, Austin",
  },
} satisfies TemplateEntry;
