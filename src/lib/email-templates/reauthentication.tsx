import * as React from "react";

import { Heading, Text } from "@react-email/components";
import { SystemLayout, systemText } from "./_brand";

interface ReauthenticationEmailProps {
  token: string;
}

export const ReauthenticationEmail = ({ token }: ReauthenticationEmailProps) => (
  <SystemLayout preview="Your verification code">
    <Heading style={systemText.h1}>Confirm reauthentication</Heading>
    <Text style={systemText.text}>Use the code below to confirm your identity:</Text>
    <Text style={codeStyle}>{token}</Text>
    <Text style={systemText.aside}>
      This code will expire shortly. If you didn't request this, you can safely ignore this email.
    </Text>
  </SystemLayout>
);

export default ReauthenticationEmail;

const codeStyle = {
  fontFamily: "Courier, monospace",
  fontSize: "28px",
  fontWeight: "bold" as const,
  letterSpacing: "6px",
  color: "#0f172a",
  backgroundColor: "#f1f5f9",
  border: "1px solid #e2e8f0",
  borderRadius: "8px",
  padding: "14px 20px",
  textAlign: "center" as const,
  margin: "0 0 8px",
};
