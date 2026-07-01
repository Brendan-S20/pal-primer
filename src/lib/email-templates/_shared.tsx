// Shared inline styles for app email templates.
export const styles = {
  main: { backgroundColor: "#ffffff", fontFamily: "Arial, sans-serif" },
  container: { padding: "24px 28px", maxWidth: "560px" },
  h1: {
    fontSize: "22px",
    fontWeight: "bold" as const,
    color: "#0f172a",
    margin: "0 0 16px",
  },
  text: {
    fontSize: "14px",
    color: "#334155",
    lineHeight: "1.55",
    margin: "0 0 16px",
  },
  small: { fontSize: "12px", color: "#64748b", margin: "24px 0 0" },
  button: {
    backgroundColor: "#0f172a",
    color: "#ffffff",
    fontSize: "14px",
    borderRadius: "8px",
    padding: "12px 20px",
    textDecoration: "none",
    display: "inline-block",
  },
  amount: {
    fontSize: "28px",
    fontWeight: "bold" as const,
    color: "#0f172a",
    margin: "8px 0 20px",
  },
  hr: { border: "none", borderTop: "1px solid #e2e8f0", margin: "24px 0" },
};

export function fmtMoney(cents: number | null | undefined) {
  const n = Number(cents ?? 0) / 100;
  return `$${n.toFixed(2)}`;
}
