import * as React from "react";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import { styles, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";

// "On my way", for a customer who cannot be texted: no consent on file yet,
// no sender, or the carrier refused it. Sent when the tech taps Navigate or
// the on-my-way button.
//
// A dog walk (#410) says walker and walk, and asks about getting in rather
// than about a dog in the yard. Every other visit renders the original
// markup, untouched: tests/a-client-hears-when-a-walk-changes.test.tsx holds
// it byte for byte against a frozen copy.

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  /** The tech's first name, or absent. */
  techName?: string;
  /** "between 10:15 AM and 10:45 AM", already on the org's clock, or absent. */
  eta?: string;
  address?: string;
  /** The live map (/track/<token>). Only when the business has live tracking
   *  on; without it this email is exactly what it was before. */
  trackUrl?: string;
  /** A dog walk. Absent for every other visit. */
  walk?: boolean;
  /** False for a sit, a groom or a lesson (#560): no dog out in the yard. */
  yard?: boolean;
}

const OnMyWay = ({
  orgName = "your service",
  clientName = "there",
  techName,
  eta,
  address,
  trackUrl,
  walk,
  yard,
  ...orgContact
}: Props) =>
  walk ? (
    <WalkOnMyWay
      orgName={orgName}
      clientName={clientName}
      techName={techName}
      eta={eta}
      address={address}
      trackUrl={trackUrl}
      {...orgContact}
    />
  ) : (
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
          {trackUrl ? (
            <Section style={{ margin: "8px 0 20px" }}>
              <Button href={trackUrl} style={styles.button}>
                {`See ${techName ?? "your tech"} on the map`}
              </Button>
              <Text style={{ ...styles.small, margin: "8px 0 0" }}>
                The map shows an approximate position until the visit starts.
              </Text>
            </Section>
          ) : null}
          <Text style={styles.text}>
            {yard === false
              ? "If anything has changed, or there is anything we should know, reply to this email."
              : "If there is a dog out in the yard, or anything the tech should know, reply to this email."}
          </Text>
          <OrgFooter {...orgContact} orgName={orgName} />
        </Container>
      </Body>
    </Html>
  );

const WalkOnMyWay = ({
  orgName = "your service",
  clientName = "there",
  techName,
  eta,
  address,
  trackUrl,
  ...orgContact
}: Props) => (
  <Html lang="en">
    <Head />
    <Preview>{`${techName ?? "Your walker"} is on the way${eta ? `, arriving ${eta}` : ""}`}</Preview>
    <Body style={styles.main}>
      <Container style={styles.container}>
        <Heading style={styles.h1}>On the way</Heading>
        <Text style={styles.text}>
          Hi {clientName}, {techName ? `${techName} from ${orgName}` : `your ${orgName} walker`} is
          on the way for today&apos;s walk
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
        {trackUrl ? (
          <Section style={{ margin: "8px 0 20px" }}>
            <Button href={trackUrl} style={styles.button}>
              {`See ${techName ?? "your walker"} on the map`}
            </Button>
            <Text style={{ ...styles.small, margin: "8px 0 0" }}>
              The map shows an approximate position until the walk starts.
            </Text>
          </Section>
        ) : null}
        <Text style={styles.text}>
          If anything has changed about getting in, or the walker should know something, reply to
          this email.
        </Text>
        <OrgFooter {...orgContact} orgName={orgName} />
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: OnMyWay,
  subject: (d: Record<string, any>) =>
    `${d.techName ?? (d.walk ? "Your walker" : "Your tech")} is on the way${d.eta ? `, arriving ${d.eta}` : ""}`,
  displayName: "On my way",
  previewData: {
    orgName: "Acme Scoop Co.",
    clientName: "Jane",
    techName: "Sam",
    eta: "between 10:15 AM and 10:45 AM",
    address: "412 Elm St, Austin",
  },
} satisfies TemplateEntry;
