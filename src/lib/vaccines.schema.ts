import { z } from "zod";
import { VACCINES, VACCINE_MAX_BYTES, VACCINE_MIME_EXT, type VaccineMime } from "@/lib/vaccines";

export const vaccineDate = z.string().date();
export const vaccineFields = z.object({
  dogId: z.string().uuid(),
  vaccine: z.enum(VACCINES),
  vaccineNote: z.string().trim().max(80).nullable().optional(),
  givenOn: vaccineDate.nullable().optional(),
  expiresOn: vaccineDate,
}).refine((v) => v.vaccine !== "other" || !!v.vaccineNote, { message: "Describe the other vaccine." })
  .refine((v) => !v.givenOn || v.givenOn <= v.expiresOn, { message: "Given on must be on or before the expiry date." });

export const vaccineMime = z.custom<VaccineMime>((v) => typeof v === "string" && Object.hasOwn(VACCINE_MIME_EXT, v), "Choose a supported photo or PDF.");
export const vaccineFileSize = z.number().int().min(1).max(VACCINE_MAX_BYTES, "Files must be 10 MB or smaller.");
export function vaccinePathMatches(path: string, orgId: string, dogId: string): boolean {
  return path.startsWith(`${orgId}/${dogId}/`) && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|heic|heif|pdf)$/.test(path);
}
