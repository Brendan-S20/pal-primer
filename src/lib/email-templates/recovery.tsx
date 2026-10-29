import * as React from "react";

import { Button, Heading, Text } from "@react-email/components";
import { SystemLayout, systemText } from "./_brand";

interface RecoveryEmailProps {
  siteName: string;
  confirmationUrl: string;
}

export const RecoveryEmail = ({ siteName, confirmationUrl }: RecoveryEmailProps) => (
  <SystemLayout preview={`Reset your password for ${siteName}`}>
    <Heading style={systemText.h1}>Reset your password</Heading>
    <Text style={systemText.text}>
      We received a request to reset your password for {siteName}. Click the button below to choose
      a new password.
    </Text>
    <Button style={systemText.button} href={confirmationUrl}>
      Reset Password
    </Button>
    <Text style={systemText.aside}>
      If you didn't request a password reset, you can safely ignore this email. Your password will
      not be changed.
    </Text>
  </SystemLayout>
);

export default RecoveryEmail;
