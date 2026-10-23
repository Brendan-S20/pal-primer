import type { ReactNode } from "react";
import { useServiceLines } from "@/components/CommercialOnly";

export function TrainingOnly({ children }: { children: ReactNode }) {
  const { lines, known } = useServiceLines();
  return known && lines.includes("training") ? <>{children}</> : null;
}
