export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      clients: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"]
          active: boolean
          created_at: string
          display_name: string
          id: string
          notes: string | null
          organization_id: string
          primary_email: string | null
          primary_phone: string | null
          updated_at: string
        }
        Insert: {
          account_type: Database["public"]["Enums"]["account_type"]
          active?: boolean
          created_at?: string
          display_name: string
          id?: string
          notes?: string | null
          organization_id: string
          primary_email?: string | null
          primary_phone?: string | null
          updated_at?: string
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"]
          active?: boolean
          created_at?: string
          display_name?: string
          id?: string
          notes?: string | null
          organization_id?: string
          primary_email?: string | null
          primary_phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clients_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      dogs: {
        Row: {
          breed: string | null
          created_at: string
          id: string
          name: string
          notes: string | null
          organization_id: string
          property_id: string
          temperament: Database["public"]["Enums"]["dog_temperament"]
          weight_class: string | null
        }
        Insert: {
          breed?: string | null
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          organization_id: string
          property_id: string
          temperament?: Database["public"]["Enums"]["dog_temperament"]
          weight_class?: string | null
        }
        Update: {
          breed?: string | null
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          organization_id?: string
          property_id?: string
          temperament?: Database["public"]["Enums"]["dog_temperament"]
          weight_class?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dogs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dogs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_line_items: {
        Row: {
          amount_cents: number
          created_at: string
          description: string
          id: string
          invoice_id: string
          subscription_id: string | null
          visit_id: string | null
        }
        Insert: {
          amount_cents: number
          created_at?: string
          description: string
          id?: string
          invoice_id: string
          subscription_id?: string | null
          visit_id?: string | null
        }
        Update: {
          amount_cents?: number
          created_at?: string
          description?: string
          id?: string
          invoice_id?: string
          subscription_id?: string | null
          visit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_items_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_items_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          checkout_url: string | null
          client_id: string
          created_at: string
          currency: string
          id: string
          issued_at: string | null
          notes: string | null
          organization_id: string
          paid_at: string | null
          period_end: string
          period_start: string | null
          status: Database["public"]["Enums"]["invoice_status"]
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          subtotal_cents: number
          total_cents: number
          updated_at: string
          voided_at: string | null
        }
        Insert: {
          checkout_url?: string | null
          client_id: string
          created_at?: string
          currency?: string
          id?: string
          issued_at?: string | null
          notes?: string | null
          organization_id: string
          paid_at?: string | null
          period_end: string
          period_start?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          subtotal_cents?: number
          total_cents?: number
          updated_at?: string
          voided_at?: string | null
        }
        Update: {
          checkout_url?: string | null
          client_id?: string
          created_at?: string
          currency?: string
          id?: string
          issued_at?: string | null
          notes?: string | null
          organization_id?: string
          paid_at?: string | null
          period_end?: string
          period_start?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          subtotal_cents?: number
          total_cents?: number
          updated_at?: string
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          city: string | null
          country: string | null
          created_at: string
          id: string
          name: string
          organization_id: string
          postal_code: string | null
          region: string | null
          street: string | null
        }
        Insert: {
          city?: string | null
          country?: string | null
          created_at?: string
          id?: string
          name: string
          organization_id: string
          postal_code?: string | null
          region?: string | null
          street?: string | null
        }
        Update: {
          city?: string | null
          country?: string | null
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          postal_code?: string | null
          region?: string | null
          street?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "locations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          active_client_count: number
          billing_tier: string | null
          created_at: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          active_client_count?: number
          billing_tier?: string | null
          created_at?: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          active_client_count?: number
          billing_tier?: string | null
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          id: string
          invoice_id: string
          organization_id: string
          paid_at: string | null
          raw_event: Json | null
          status: Database["public"]["Enums"]["payment_status"]
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency?: string
          id?: string
          invoice_id: string
          organization_id: string
          paid_at?: string | null
          raw_event?: Json | null
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          id?: string
          invoice_id?: string
          organization_id?: string
          paid_at?: string | null
          raw_event?: Json | null
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      properties: {
        Row: {
          access_notes: string | null
          city: string
          client_id: string
          country: string | null
          created_at: string
          dog_in_yard_during_service: boolean
          escape_risk: boolean
          gate_code: string | null
          id: string
          invisible_fence: boolean
          key_location: string | null
          label: string | null
          lock_box_code: string | null
          organization_id: string
          parking_notes: string | null
          postal_code: string
          region: string | null
          street: string
        }
        Insert: {
          access_notes?: string | null
          city: string
          client_id: string
          country?: string | null
          created_at?: string
          dog_in_yard_during_service?: boolean
          escape_risk?: boolean
          gate_code?: string | null
          id?: string
          invisible_fence?: boolean
          key_location?: string | null
          label?: string | null
          lock_box_code?: string | null
          organization_id: string
          parking_notes?: string | null
          postal_code: string
          region?: string | null
          street: string
        }
        Update: {
          access_notes?: string | null
          city?: string
          client_id?: string
          country?: string | null
          created_at?: string
          dog_in_yard_during_service?: boolean
          escape_risk?: boolean
          gate_code?: string | null
          id?: string
          invisible_fence?: boolean
          key_location?: string | null
          label?: string | null
          lock_box_code?: string | null
          organization_id?: string
          parking_notes?: string | null
          postal_code?: string
          region?: string | null
          street?: string
        }
        Relationships: [
          {
            foreignKeyName: "properties_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "properties_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      staff: {
        Row: {
          active: boolean
          created_at: string
          display_name: string
          email: string | null
          id: string
          location_id: string | null
          organization_id: string
          phone: string | null
          role: Database["public"]["Enums"]["staff_role"]
          user_id: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_name: string
          email?: string | null
          id?: string
          location_id?: string | null
          organization_id: string
          phone?: string | null
          role: Database["public"]["Enums"]["staff_role"]
          user_id: string
        }
        Update: {
          active?: boolean
          created_at?: string
          display_name?: string
          email?: string | null
          id?: string
          location_id?: string | null
          organization_id?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["staff_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"]
          billing_cadence: Database["public"]["Enums"]["billing_cadence"]
          client_id: string
          created_at: string
          dog_count: number | null
          frequency: Database["public"]["Enums"]["service_frequency"]
          id: string
          organization_id: string
          price_cents: number
          property_id: string
          started_on: string
          status: Database["public"]["Enums"]["subscription_status"]
          unit_count: number | null
          zone_id: string | null
        }
        Insert: {
          account_type: Database["public"]["Enums"]["account_type"]
          billing_cadence?: Database["public"]["Enums"]["billing_cadence"]
          client_id: string
          created_at?: string
          dog_count?: number | null
          frequency: Database["public"]["Enums"]["service_frequency"]
          id?: string
          organization_id: string
          price_cents: number
          property_id: string
          started_on?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          unit_count?: number | null
          zone_id?: string | null
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"]
          billing_cadence?: Database["public"]["Enums"]["billing_cadence"]
          client_id?: string
          created_at?: string
          dog_count?: number | null
          frequency?: Database["public"]["Enums"]["service_frequency"]
          id?: string
          organization_id?: string
          price_cents?: number
          property_id?: string
          started_on?: string
          status?: Database["public"]["Enums"]["subscription_status"]
          unit_count?: number | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_zone_fk"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "zones"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      visit_photos: {
        Row: {
          created_at: string
          id: string
          kind: string
          organization_id: string
          storage_path: string
          uploaded_by: string
          visit_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: string
          organization_id: string
          storage_path: string
          uploaded_by: string
          visit_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          organization_id?: string
          storage_path?: string
          uploaded_by?: string
          visit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "visit_photos_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visit_photos_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      visits: {
        Row: {
          assigned_staff_id: string | null
          client_id: string
          completed_at: string | null
          created_at: string
          id: string
          organization_id: string
          property_id: string
          scheduled_on: string
          sequence: number | null
          skip_reason: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["visit_status"]
          subscription_id: string
          updated_at: string
          zone_id: string | null
        }
        Insert: {
          assigned_staff_id?: string | null
          client_id: string
          completed_at?: string | null
          created_at?: string
          id?: string
          organization_id: string
          property_id: string
          scheduled_on: string
          sequence?: number | null
          skip_reason?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["visit_status"]
          subscription_id: string
          updated_at?: string
          zone_id?: string | null
        }
        Update: {
          assigned_staff_id?: string | null
          client_id?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          organization_id?: string
          property_id?: string
          scheduled_on?: string
          sequence?: number | null
          skip_reason?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["visit_status"]
          subscription_id?: string
          updated_at?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "visits_assigned_staff_id_fkey"
            columns: ["assigned_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "visits_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "zones"
            referencedColumns: ["id"]
          },
        ]
      }
      zones: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"] | null
          created_at: string
          id: string
          name: string
          organization_id: string
          postal_prefix: string | null
          price_note: string | null
        }
        Insert: {
          account_type?: Database["public"]["Enums"]["account_type"] | null
          created_at?: string
          id?: string
          name: string
          organization_id: string
          postal_prefix?: string | null
          price_note?: string | null
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"] | null
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          postal_prefix?: string | null
          price_note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "zones_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      assign_route_for_day: {
        Args: {
          _day: string
          _org_id: string
          _reassign?: boolean
          _staff_id: string
        }
        Returns: number
      }
      bootstrap_organization: {
        Args: { _display_name: string; _org_name: string }
        Returns: string
      }
      can_write_org: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      complete_visit: { Args: { _visit_id: string }; Returns: undefined }
      generate_invoice_for_client: {
        Args: { _client_id: string; _through: string }
        Returns: string
      }
      generate_invoices_for_org: {
        Args: { _org_id: string; _through: string }
        Returns: number
      }
      generate_visits_through: {
        Args: { _org_id: string; _through: string }
        Returns: number
      }
      has_role: {
        Args: {
          _org_id: string
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_org_member: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      is_visit_tech: {
        Args: { _user_id: string; _visit_id: string }
        Returns: boolean
      }
      next_visit_date: {
        Args: {
          _freq: Database["public"]["Enums"]["service_frequency"]
          _from: string
        }
        Returns: string
      }
      refresh_active_client_count: {
        Args: { _org_id: string }
        Returns: undefined
      }
      skip_visit: {
        Args: { _reason: string; _visit_id: string }
        Returns: undefined
      }
      start_visit: { Args: { _visit_id: string }; Returns: undefined }
      void_invoice: { Args: { _invoice_id: string }; Returns: undefined }
    }
    Enums: {
      account_type: "residential" | "commercial"
      app_role: "owner" | "office_manager" | "dispatcher" | "tech"
      billing_cadence: "prepaid" | "postpaid"
      dog_temperament: "friendly" | "nervous" | "aggressive" | "unknown"
      invoice_status: "draft" | "open" | "paid" | "void" | "uncollectible"
      payment_status: "pending" | "succeeded" | "failed" | "refunded"
      service_frequency:
        | "weekly"
        | "biweekly"
        | "twice_weekly"
        | "monthly"
        | "one_time"
      staff_role: "owner" | "office_manager" | "dispatcher" | "tech"
      subscription_status: "active" | "paused" | "canceled"
      visit_status:
        | "scheduled"
        | "in_progress"
        | "completed"
        | "skipped"
        | "canceled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_type: ["residential", "commercial"],
      app_role: ["owner", "office_manager", "dispatcher", "tech"],
      billing_cadence: ["prepaid", "postpaid"],
      dog_temperament: ["friendly", "nervous", "aggressive", "unknown"],
      invoice_status: ["draft", "open", "paid", "void", "uncollectible"],
      payment_status: ["pending", "succeeded", "failed", "refunded"],
      service_frequency: [
        "weekly",
        "biweekly",
        "twice_weekly",
        "monthly",
        "one_time",
      ],
      staff_role: ["owner", "office_manager", "dispatcher", "tech"],
      subscription_status: ["active", "paused", "canceled"],
      visit_status: [
        "scheduled",
        "in_progress",
        "completed",
        "skipped",
        "canceled",
      ],
    },
  },
} as const
