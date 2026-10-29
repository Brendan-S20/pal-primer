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
import { styles, OrgFooter, type OrgContact, TenantHeader } from "./_shared";
import type { TemplateEntry } from "./registry";

// Sent once per package for each notice: when a used session leaves one
// session on it, and 14 days before it expires. See
// src/lib/training-portal.server.ts.

interface Props extends OrgContact {
  orgName?: string;
  clientName?: string;
  kind?: "one_left" | "expiring";
  packageName?: string;
  /** Sessions not yet used, booked lessons included. */
  left?: number;
  /** "Friday, October 30", on the org's calendar. */
  expiresLabel?: string | null;
  /** The client's Training page in the portal. */
  portalUrl?: string;
}

const TrainingPackageNotice = ({
  orgName = "your trainer",
  clientName = "there",
  kind = "one_left",
  packageName = "your training package",
  left = 1,
  expiresLabel = null,
  portalUrl,
  ...orgContact
}: Props) => {
  const heading =
    kind === "one_left" ? "One session left" : `Your package expires on ${expiresLabel}`;
  return (
    <Html lang="en">
      <Head />
      <Preview>{`${heading}: ${packageName}`}</Preview>
      <Body style={styles.main}>
        <Container style={styles.container}>
          <TenantHeader {...orgContact} orgName={orgName} />
          <Heading style={styles.h1}>{heading}</Heading>
          <Text style={styles.text}>
            Hi {clientName},{" "}
            {kind === "one_left" ? (
              <>
                your <strong>{packageName}</strong> with {orgName} has one session left.
              </>
            ) : (
              <>
                your <strong>{packageName}</strong> with {orgName} expires on{" "}
                <strong>{expiresLabel}</strong>, with {left} session{left === 1 ? "" : "s"} left.
                Sessions not used by then lapse.
              </>
            )}
          </Text>
          {portalUrl ? (
            <>
              <Text style={styles.text}>
                You can request your next lesson or buy another package in your portal.
              </Text>
              <Button href={portalUrl} style={styles.button}>
                Open my training
              </Button>
            </>
          ) : (
            <Text style={styles.text}>Reply to this email to book your next lesson.</Text>
          )}
          <OrgFooter {...orgContact} orgName={orgName} />
        </Container>
      </Body>
    </Html>
  );
};

export const template = {
  component: TrainingPackageNotice,
  subject: (d: Record<string, unknown>) =>
    d.kind === "expiring"
      ? `Your training package expires on ${String(d.expiresLabel ?? "soon")}`
      : "One session left on your training package",
  displayName: "Training package notice",
  previewData: {
    orgName: "Good Dog Training",
    clientName: "Jane",
    kind: "expiring",
    packageName: "6-session package",
    left: 2,
    expiresLabel: "Friday, October 30",
    portalUrl: "https://example.com/portal/good-dog/abc123/training",
  },
} satisfies TemplateEntry;
