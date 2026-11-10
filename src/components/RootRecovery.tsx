import { Component, type ReactNode } from "react";
import i18n from "@/lib/i18n";
import { reportLovableError } from "@/lib/lovable-error-reporting";
import { reportBoundaryError } from "@/lib/monitoring/client";

// A backstop for errors thrown outside the router's boundaries. Track failure
// separately from its value.
export class RootRecovery extends Component<{ children: ReactNode }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    reportLovableError(error, { boundary: "root_shell" });
    reportBoundaryError(error, "root_shell");
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground"
      >
        <div className="w-full max-w-md rounded-lg border bg-card p-6 text-center">
          <h1 className="text-xl font-semibold">{i18n.t("recovery.title")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{i18n.t("recovery.body")}</p>
          <a
            href="/dashboard"
            className="mt-6 inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {i18n.t("recovery.dashboard")}
          </a>
        </div>
      </div>
    );
  }
}
