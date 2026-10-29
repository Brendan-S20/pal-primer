import * as React from "react";

import { Button, Heading, Link, Text } from "@react-email/components";
import { SystemLayout, systemText } from "./_brand";

interface InviteEmailProps {
  siteName: string;
  siteUrl: string;
  confirmationUrl: string;
}

export const InviteEmail = ({ siteName, siteUrl, confirmationUrl }: InviteEmailProps) => (
  <SystemLayout preview={`You've been invited to join ${siteName}`}>
    <Heading style={systemText.h1}>You've been invited</Heading>
    <Text style={systemText.text}>
      You've been invited to join{" "}
      <Link href={siteUrl} style={systemText.link}>
        <strong>{siteName}</strong>
      </Link>
      . Click the button below to accept the invitation and create your account.
    </Text>
    <Button style={systemText.button} href={confirmationUrl}>
      Accept Invitation
    </Button>
    <Text style={systemText.aside}>
      If you weren't expecting this invitation, you can safely ignore this email.
    </Text>
  </SystemLayout>
);

export default InviteEmail;
