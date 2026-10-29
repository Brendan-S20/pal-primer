import * as React from "react";

import { Button, Heading, Link, Text } from "@react-email/components";
import { SystemLayout, systemText } from "./_brand";

interface SignupEmailProps {
  siteName: string;
  siteUrl: string;
  recipient: string;
  confirmationUrl: string;
}

export const SignupEmail = ({
  siteName,
  siteUrl,
  recipient,
  confirmationUrl,
}: SignupEmailProps) => (
  <SystemLayout preview={`Confirm your email for ${siteName}`}>
    <Heading style={systemText.h1}>Confirm your email</Heading>
    <Text style={systemText.text}>
      Thanks for signing up for{" "}
      <Link href={siteUrl} style={systemText.link}>
        <strong>{siteName}</strong>
      </Link>
      !
    </Text>
    <Text style={systemText.text}>
      Please confirm your email address (
      <Link href={`mailto:${recipient}`} style={systemText.link}>
        {recipient}
      </Link>
      ) by clicking the button below:
    </Text>
    <Button style={systemText.button} href={confirmationUrl}>
      Verify Email
    </Button>
    <Text style={systemText.aside}>
      If you didn't create an account, you can safely ignore this email.
    </Text>
  </SystemLayout>
);

export default SignupEmail;
