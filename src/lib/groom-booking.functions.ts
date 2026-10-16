import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { bookGroomAppointment } from "@/lib/groom-booking.server";
import { COAT_TYPES, petSize, type CoatType, type PetSize } from "@/lib/groom";
import { vaccineStatus } from "@/lib/vaccines";
import { loadVaccineSettings } from "@/lib/vaccines.server";

const bookSchema = z.object({
  clientId: z.string().uuid(),
  propertyId: z.string().uuid(),
  serviceId: z.string().uuid(),
  petIds: z.array(z.string().uuid()).min(1).max(20),
  addons: z
    .array(
      z.object({
        addonServiceId: z.string().uuid(),
        quantity: z.number().int().min(1).max(20),
      }),
    )
    .max(20),
  scheduledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  everyWeeks: z.number().int().min(1).max(26).nullable(),
  staffId: z.string().uuid().nullable(),
  parkingNotes: z.string().max(1000).nullable(),
  acknowledgeWarning: z.boolean(),
});

export const bookGroom = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => bookSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_pricing");
    return bookGroomAppointment(context.supabase, {
      ...data,
      orgId,
      actorUserId: context.userId,
    });
  });

function coatOf(value: unknown): CoatType | null {
  return typeof value === "string" && (COAT_TYPES as readonly string[]).includes(value)
    ? (value as CoatType)
    : null;
}

/** What the book-a-groom dialog needs. Office only, same permission as booking. */
export const groomBookingOptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_pricing");
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id")
      .eq("id", data.clientId)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!client || client.organization_id !== orgId)
      throw new Error("That client is not in your organization.");

    const [props, services, dogs, addons, staff, rules, settings] = await Promise.all([
      supabase
        .from("properties")
        .select("id, street, city, parking_notes")
        .eq("client_id", data.clientId)
        .eq("organization_id", orgId)
        .is("archived_at", null)
        .order("created_at"),
      supabase
        .from("services")
        .select(
          "id, name, price_unit, base_price_cents, extra_pet_cents, default_duration_min, active",
        )
        .eq("organization_id", orgId)
        .eq("service_line", "mobile_grooming")
        .eq("active", true)
        .order("name"),
      supabase
        .from("dogs")
        .select("id, property_id, name, breed, weight_class, weight_lb, coat_type")
        .eq("organization_id", orgId)
        .not("active", "is", false),
      supabase
        .from("addon_services")
        .select("id, name, unit_price_cents, duration_min, service_line, active")
        .eq("organization_id", orgId)
        .eq("active", true)
        .order("name"),
      supabase
        .from("staff")
        .select("id, display_name, is_field_tech, active")
        .eq("organization_id", orgId)
        .eq("active", true)
        .order("display_name"),
      supabase
        .from("service_size_rules")
        .select("service_id, size, coat_type, duration_min, price_cents")
        .eq("organization_id", orgId),
      loadVaccineSettings(supabase, orgId),
    ]);
    for (const res of [props, services, dogs, addons, staff, rules]) {
      if (res.error) throw new Error(res.error.message);
    }

    const propertyIds = new Set((props.data ?? []).map((p) => p.id));
    const petRows = (dogs.data ?? []).filter((d) => propertyIds.has(d.property_id));
    let vaccines: Array<{
      dog_id: string;
      vaccine: string;
      expires_on: string;
      source: string;
      verified_at: string | null;
    }> = [];
    if (settings.enabled && petRows.length > 0) {
      const { data: rows, error } = await supabase
        .from("pet_vaccinations")
        .select("dog_id, vaccine, expires_on, source, verified_at")
        .eq("organization_id", orgId)
        .in(
          "dog_id",
          petRows.map((d) => d.id),
        );
      if (error) throw new Error(error.message);
      vaccines = rows ?? [];
    }

    return {
      today: settings.today,
      vaccineRule: settings.enabled ? settings.rule : ("off" as const),
      properties: props.data ?? [],
      services: services.data ?? [],
      rules: (rules.data ?? []).map((r) => ({
        service_id: r.service_id,
        size: r.size as PetSize,
        coat_type: coatOf(r.coat_type),
        duration_min: r.duration_min,
        price_cents: r.price_cents,
      })),
      pets: petRows.map((d) => {
        const records = vaccines.filter((v) => v.dog_id === d.id);
        const status =
          settings.enabled && settings.rule !== "off"
            ? vaccineStatus(records, settings.required, settings.today).overall
            : ("ok" as const);
        return {
          id: d.id,
          property_id: d.property_id,
          name: d.name,
          breed: d.breed,
          size: petSize(d.weight_class, d.weight_lb == null ? null : Number(d.weight_lb)),
          coat_type: coatOf(d.coat_type),
          vaccine: status,
        };
      }),
      addons: (addons.data ?? []).filter(
        (a) => !a.service_line || a.service_line === "mobile_grooming",
      ),
      staff: (staff.data ?? []).filter((s) => s.is_field_tech),
    };
  });
