import * as React from "react";
import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import { styles, OrgFooter, type OrgContact } from "./_shared";
import type { TemplateEntry } from "./registry";
import { walkNotDoneSubject, type WalkNotDoneKind } from "@/lib/walk-notify";

// A dog walk that did not happen (#410): the walker skipped it, or the day
// passed with nobody starting it. Dog walking visits only, so a pet-waste
// client never receives this (src/lib/walk-notify.server.ts).

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  kind?: WalkNotDoneKind;
  /** "Bella", "Bella and Max", or "your dog". */
  dogs?: string;
  /** "Mon, Oct 19". */
  day?: string;
  /** The skip reason in plain words (walkSkipReason). A walk's own codes
   *  read as: could not get in, the key or code did not work, no one was
   *  home, the dog was not well enough, or the weather. Skipped only. */
  reason?: string;
}

const WalkNotDone = ({
  orgName = "your walker",
  clientName = "there",
  kind = "skipped",
  dogs = "your dog",
  day = "",
  reason,
  ...orgContact
}: Props) => {
  const subject = walkNotDoneSubject(kind, dogs, day);
  return (
    <Html lang="en">
      <Head />
      <Preview>{subject}</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <Heading style={styles.h1}>{subject}</Heading>
          {kind === "skipped" ? (
            <>
              <Text style={styles.text}>Hi {clientName},</Text>
              <Text style={styles.text}>{reason ?? "The walker could not do the walk today."}</Text>
              <Text style={styles.text}>
                If you have a question, or want to book another time, reply to this email.
              </Text>
            </>
          ) : (
            <Text style={styles.text}>
              Hi {clientName}, your walk on <strong>{day}</strong> did not happen. {orgName} will be
              in touch.
            </Text>
          )}
          <OrgFooter {...orgContact} orgName={orgName} />
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: WalkNotDone,
  subject: (d: Record<string, any>) =>
    walkNotDoneSubject(d.kind === "missed" ? "missed" : "skipped", d.dogs ?? "your dog", d.day ?? ""),
  displayName: "Walk not done",
  previewData: {
    orgName: "Acme Dog Walking",
    clientName: "Jane",
    kind: "skipped",
    dogs: "Bella",
    day: "Mon, Oct 19",
    reason: "The walker could not get in because the gate was locked.",
  },
} satisfies TemplateEntry;
