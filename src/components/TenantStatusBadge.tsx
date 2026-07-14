import { Badge } from "@/components/ui/badge";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  free: "outline",
  active: "default",
  past_due: "destructive",
  grace: "secondary",
  suspended: "destructive",
  canceled: "outline",
};

const STATUS_LABEL: Record<string, string> = {
  free: "Free",
  active: "Active",
  past_due: "Past due",
  grace: "Grace",
  suspended: "Suspended",
  canceled: "Canceled",
};

export function TenantStatusBadge({
  status,
  className,
}: {
  status: string | null | undefined;
  className?: string;
}) {
  const key = status ?? "";
  return (
    <Badge variant={STATUS_VARIANT[key] ?? "outline"} className={className}>
      {STATUS_LABEL[key] ?? (status ?? "-")}
    </Badge>
  );
}

export const TENANT_STATUS_LABEL = STATUS_LABEL;
export const TENANT_STATUS_VARIANT = STATUS_VARIANT;
