import * as React from "react";

import { Button, Heading, Text } from "@react-email/components";
import { SystemLayout, systemText } from "./_brand";

interface MagicLinkEmailProps {
  siteName: string;
  confirmationUrl: string;
}

export const MagicLinkEmail = ({ siteName, confirmationUrl }: MagicLinkEmailProps) => (
  <SystemLayout preview={`Your login link for ${siteName}`}>
    <Heading style={systemText.h1}>Your login link</Heading>
    <Text style={systemText.text}>
      Click the button below to log in to {siteName}. This link will expire shortly.
    </Text>
    <Button style={systemText.button} href={confirmationUrl}>
      Log In
    </Button>
    <Text style={systemText.aside}>
      If you didn't request this link, you can safely ignore this email.
    </Text>
  </SystemLayout>
);

export default MagicLinkEmail;
