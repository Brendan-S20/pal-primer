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
      addon_charges: {
        Row: {
          addon_service_id: string | null
          addon_subscription_id: string | null
          amount_cents: number
          client_id: string
          created_at: string
          created_by: string | null
          credit_ledger_id: string | null
          description: string
          id: string
          invoice_line_item_id: string | null
          note: string | null
          occurred_on: string
          organization_id: string
          quantity: number
          source: string
          status: Database["public"]["Enums"]["addon_charge_status"]
          unit_price_cents: number
          updated_at: string
          visit_id: string | null
        }
        Insert: {
          addon_service_id?: string | null
          addon_subscription_id?: string | null
          amount_cents: number
          client_id: string
          created_at?: string
          created_by?: string | null
          credit_ledger_id?: string | null
          description: string
          id?: string
          invoice_line_item_id?: string | null
          note?: string | null
          occurred_on?: string
          organization_id: string
          quantity?: number
          source?: string
          status?: Database["public"]["Enums"]["addon_charge_status"]
          unit_price_cents: number
          updated_at?: string
          visit_id?: string | null
        }
        Update: {
          addon_service_id?: string | null
          addon_subscription_id?: string | null
          amount_cents?: number
          client_id?: string
          created_at?: string
          created_by?: string | null
          credit_ledger_id?: string | null
          description?: string
          id?: string
          invoice_line_item_id?: string | null
          note?: string | null
          occurred_on?: string
          organization_id?: string
          quantity?: number
          source?: string
          status?: Database["public"]["Enums"]["addon_charge_status"]
          unit_price_cents?: number
          updated_at?: string
          visit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "addon_charges_addon_service_id_fkey"
            columns: ["addon_service_id"]
            isOneToOne: false
            referencedRelation: "addon_services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "addon_charges_addon_subscription_id_fkey"
            columns: ["addon_subscription_id"]
            isOneToOne: false
            referencedRelation: "addon_subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "addon_charges_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "addon_charges_credit_ledger_id_fkey"
            columns: ["credit_ledger_id"]
            isOneToOne: false
            referencedRelation: "credit_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "addon_charges_invoice_line_item_id_fkey"
            columns: ["invoice_line_item_id"]
            isOneToOne: false
            referencedRelation: "invoice_line_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "addon_charges_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "addon_charges_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      addon_services: {
        Row: {
          active: boolean
          code: string
          created_at: string
          default_frequency:
            | Database["public"]["Enums"]["addon_frequency"]
            | null
          description: string | null
          id: string
          kind: Database["public"]["Enums"]["addon_kind"]
          name: string
          organization_id: string
          taxable: boolean
          unit_price_cents: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          default_frequency?:
            | Database["public"]["Enums"]["addon_frequency"]
            | null
          description?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["addon_kind"]
          name: string
          organization_id: string
          taxable?: boolean
          unit_price_cents?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          default_frequency?:
            | Database["public"]["Enums"]["addon_frequency"]
            | null
          description?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["addon_kind"]
          name?: string
          organization_id?: string
          taxable?: boolean
          unit_price_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "addon_services_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      addon_subscriptions: {
        Row: {
          addon_service_id: string
          client_id: string
          created_at: string
          frequency: Database["public"]["Enums"]["addon_frequency"]
          id: string
          next_charge_on: string
          notes: string | null
          organization_id: string
          price_cents: number
          quantity: number
          started_on: string
          status: string
          updated_at: string
        }
        Insert: {
          addon_service_id: string
          client_id: string
          created_at?: string
          frequency: Database["public"]["Enums"]["addon_frequency"]
          id?: string
          next_charge_on?: string
          notes?: string | null
          organization_id: string
          price_cents: number
          quantity?: number
          started_on?: string
          status?: string
          updated_at?: string
        }
        Update: {
          addon_service_id?: string
          client_id?: string
          created_at?: string
          frequency?: Database["public"]["Enums"]["addon_frequency"]
          id?: string
          next_charge_on?: string
          notes?: string | null
          organization_id?: string
          price_cents?: number
          quantity?: number
          started_on?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "addon_subscriptions_addon_service_id_fkey"
            columns: ["addon_service_id"]
            isOneToOne: false
            referencedRelation: "addon_services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "addon_subscriptions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "addon_subscriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_receptionist_logs: {
        Row: {
          call_sid: string | null
          channel: string
          created_at: string
          error: string | null
          escalated: boolean
          from_number: string | null
          id: string
          inbound_message_id: string | null
          latency_ms: number | null
          model: string | null
          organization_id: string
          outbound_message_id: string | null
          reply_text: string | null
          tool_calls: Json | null
          turn: number | null
          user_text: string | null
        }
        Insert: {
          call_sid?: string | null
          channel?: string
          created_at?: string
          error?: string | null
          escalated?: boolean
          from_number?: string | null
          id?: string
          inbound_message_id?: string | null
          latency_ms?: number | null
          model?: string | null
          organization_id: string
          outbound_message_id?: string | null
          reply_text?: string | null
          tool_calls?: Json | null
          turn?: number | null
          user_text?: string | null
        }
        Update: {
          call_sid?: string | null
          channel?: string
          created_at?: string
          error?: string | null
          escalated?: boolean
          from_number?: string | null
          id?: string
          inbound_message_id?: string | null
          latency_ms?: number | null
          model?: string | null
          organization_id?: string
          outbound_message_id?: string | null
          reply_text?: string | null
          tool_calls?: Json | null
          turn?: number | null
          user_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_receptionist_logs_inbound_message_id_fkey"
            columns: ["inbound_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_receptionist_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_receptionist_logs_outbound_message_id_fkey"
            columns: ["outbound_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      blackout_dates: {
        Row: {
          blackout_on: string
          created_at: string
          id: string
          organization_id: string
          reason: string | null
        }
        Insert: {
          blackout_on: string
          created_at?: string
          id?: string
          organization_id: string
          reason?: string | null
        }
        Update: {
          blackout_on?: string
          created_at?: string
          id?: string
          organization_id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "blackout_dates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"]
          active: boolean
          churn_reason: string | null
          churn_score: number | null
          churn_scored_at: string | null
          created_at: string
          credit_balance_cents: number
          display_name: string
          email_opt_out: boolean
          id: string
          import_batch_id: string | null
          import_external_id: string | null
          import_source: Database["public"]["Enums"]["import_source"] | null
          notes: string | null
          organization_id: string
          portal_token: string
          primary_email: string | null
          primary_phone: string | null
          referral_applied_at: string | null
          referral_code: string | null
          referred_by_client_id: string | null
          review_asked_at: string | null
          review_submitted_at: string | null
          sms_opt_out: boolean
          updated_at: string
        }
        Insert: {
          account_type: Database["public"]["Enums"]["account_type"]
          active?: boolean
          churn_reason?: string | null
          churn_score?: number | null
          churn_scored_at?: string | null
          created_at?: string
          credit_balance_cents?: number
          display_name: string
          email_opt_out?: boolean
          id?: string
          import_batch_id?: string | null
          import_external_id?: string | null
          import_source?: Database["public"]["Enums"]["import_source"] | null
          notes?: string | null
          organization_id: string
          portal_token?: string
          primary_email?: string | null
          primary_phone?: string | null
          referral_applied_at?: string | null
          referral_code?: string | null
          referred_by_client_id?: string | null
          review_asked_at?: string | null
          review_submitted_at?: string | null
          sms_opt_out?: boolean
          updated_at?: string
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"]
          active?: boolean
          churn_reason?: string | null
          churn_score?: number | null
          churn_scored_at?: string | null
          created_at?: string
          credit_balance_cents?: number
          display_name?: string
          email_opt_out?: boolean
          id?: string
          import_batch_id?: string | null
          import_external_id?: string | null
          import_source?: Database["public"]["Enums"]["import_source"] | null
          notes?: string | null
          organization_id?: string
          portal_token?: string
          primary_email?: string | null
          primary_phone?: string | null
          referral_applied_at?: string | null
          referral_code?: string | null
          referred_by_client_id?: string | null
          review_asked_at?: string | null
          review_submitted_at?: string | null
          sms_opt_out?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clients_import_batch_id_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clients_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clients_referred_by_client_id_fkey"
            columns: ["referred_by_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_ledger: {
        Row: {
          client_id: string
          created_at: string
          delta_cents: number
          id: string
          invoice_id: string | null
          kind: string
          note: string | null
          organization_id: string
          visit_id: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          delta_cents: number
          id?: string
          invoice_id?: string | null
          kind: string
          note?: string | null
          organization_id: string
          visit_id?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          delta_cents?: number
          id?: string
          invoice_id?: string | null
          kind?: string
          note?: string | null
          organization_id?: string
          visit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "credit_ledger_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_ledger_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_ledger_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_ledger_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
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
      email_send_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          message_id: string | null
          metadata: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email: string
          status: string
          template_name: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          message_id?: string | null
          metadata?: Json | null
          recipient_email?: string
          status?: string
          template_name?: string
        }
        Relationships: []
      }
      email_send_state: {
        Row: {
          auth_email_ttl_minutes: number
          batch_size: number
          id: number
          retry_after_until: string | null
          send_delay_ms: number
          transactional_email_ttl_minutes: number
          updated_at: string
        }
        Insert: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Update: {
          auth_email_ttl_minutes?: number
          batch_size?: number
          id?: number
          retry_after_until?: string | null
          send_delay_ms?: number
          transactional_email_ttl_minutes?: number
          updated_at?: string
        }
        Relationships: []
      }
      email_unsubscribe_tokens: {
        Row: {
          created_at: string
          email: string
          id: string
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: []
      }
      import_batches: {
        Row: {
          committed_at: string | null
          created_at: string
          created_by: string
          entity: string
          error: string | null
          filename: string | null
          id: string
          mapping: Json
          organization_id: string
          source: Database["public"]["Enums"]["import_source"]
          stats: Json
          status: Database["public"]["Enums"]["import_status"]
          updated_at: string
        }
        Insert: {
          committed_at?: string | null
          created_at?: string
          created_by: string
          entity?: string
          error?: string | null
          filename?: string | null
          id?: string
          mapping?: Json
          organization_id: string
          source: Database["public"]["Enums"]["import_source"]
          stats?: Json
          status?: Database["public"]["Enums"]["import_status"]
          updated_at?: string
        }
        Update: {
          committed_at?: string | null
          created_at?: string
          created_by?: string
          entity?: string
          error?: string | null
          filename?: string | null
          id?: string
          mapping?: Json
          organization_id?: string
          source?: Database["public"]["Enums"]["import_source"]
          stats?: Json
          status?: Database["public"]["Enums"]["import_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_batches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      import_rows: {
        Row: {
          action: Database["public"]["Enums"]["import_row_action"]
          batch_id: string
          created_at: string
          error: string | null
          id: string
          mapped: Json | null
          organization_id: string
          raw: Json
          row_num: number
          target_id: string | null
        }
        Insert: {
          action?: Database["public"]["Enums"]["import_row_action"]
          batch_id: string
          created_at?: string
          error?: string | null
          id?: string
          mapped?: Json | null
          organization_id: string
          raw: Json
          row_num: number
          target_id?: string | null
        }
        Update: {
          action?: Database["public"]["Enums"]["import_row_action"]
          batch_id?: string
          created_at?: string
          error?: string | null
          id?: string
          mapped?: Json | null
          organization_id?: string
          raw?: Json
          row_num?: number
          target_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "import_rows_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_rows_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
          kind: Database["public"]["Enums"]["invoice_kind"]
          last_email_reminder_at: string | null
          last_reminder_at: string | null
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
          kind?: Database["public"]["Enums"]["invoice_kind"]
          last_email_reminder_at?: string | null
          last_reminder_at?: string | null
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
          kind?: Database["public"]["Enums"]["invoice_kind"]
          last_email_reminder_at?: string | null
          last_reminder_at?: string | null
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
      leads: {
        Row: {
          company: string | null
          contacted_at: string | null
          converted_at: string | null
          created_at: string
          dog_count: number | null
          email: string
          frequency: string | null
          id: string
          location: string | null
          message: string | null
          name: string
          phone: string | null
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          company?: string | null
          contacted_at?: string | null
          converted_at?: string | null
          created_at?: string
          dog_count?: number | null
          email: string
          frequency?: string | null
          id?: string
          location?: string | null
          message?: string | null
          name: string
          phone?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          company?: string | null
          contacted_at?: string | null
          converted_at?: string | null
          created_at?: string
          dog_count?: number | null
          email?: string
          frequency?: string | null
          id?: string
          location?: string | null
          message?: string | null
          name?: string
          phone?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
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
      messages: {
        Row: {
          ai_handled: boolean
          body: string
          client_id: string | null
          created_at: string
          direction: Database["public"]["Enums"]["message_direction"]
          error: string | null
          from_number: string | null
          id: string
          organization_id: string
          staff_id: string | null
          status: Database["public"]["Enums"]["message_status"]
          to_number: string | null
          twilio_sid: string | null
          updated_at: string
          visit_id: string | null
        }
        Insert: {
          ai_handled?: boolean
          body: string
          client_id?: string | null
          created_at?: string
          direction: Database["public"]["Enums"]["message_direction"]
          error?: string | null
          from_number?: string | null
          id?: string
          organization_id: string
          staff_id?: string | null
          status?: Database["public"]["Enums"]["message_status"]
          to_number?: string | null
          twilio_sid?: string | null
          updated_at?: string
          visit_id?: string | null
        }
        Update: {
          ai_handled?: boolean
          body?: string
          client_id?: string | null
          created_at?: string
          direction?: Database["public"]["Enums"]["message_direction"]
          error?: string | null
          from_number?: string | null
          id?: string
          organization_id?: string
          staff_id?: string | null
          status?: Database["public"]["Enums"]["message_status"]
          to_number?: string | null
          twilio_sid?: string | null
          updated_at?: string
          visit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          active_client_count: number
          ai_receptionist_enabled: boolean
          ai_receptionist_faq: string | null
          ai_receptionist_persona: string | null
          ai_voice_enabled: boolean
          ai_voice_greeting: string | null
          auto_generate_days_ahead: number
          auto_generate_visits: boolean
          auto_invoice_enabled: boolean
          billing_tier: string | null
          created_at: string
          currency: string
          current_period_end: string | null
          frequency_multipliers: Json
          google_review_url: string | null
          id: string
          name: string
          notify_email_invoice_sent: boolean
          notify_email_overdue: boolean
          notify_email_payment_received: boolean
          notify_email_visit_completed: boolean
          notify_email_weather_reschedule: boolean
          notify_email_welcome: boolean
          overdue_reminder_days: number
          overdue_reminders_enabled: boolean
          plan_status: Database["public"]["Enums"]["org_plan_status"]
          public_signup_enabled: boolean
          referral_reward_cents: number
          review_ask_enabled: boolean
          review_ask_template: string | null
          slug: string | null
          sms_from_number: string | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          active_client_count?: number
          ai_receptionist_enabled?: boolean
          ai_receptionist_faq?: string | null
          ai_receptionist_persona?: string | null
          ai_voice_enabled?: boolean
          ai_voice_greeting?: string | null
          auto_generate_days_ahead?: number
          auto_generate_visits?: boolean
          auto_invoice_enabled?: boolean
          billing_tier?: string | null
          created_at?: string
          currency?: string
          current_period_end?: string | null
          frequency_multipliers?: Json
          google_review_url?: string | null
          id?: string
          name: string
          notify_email_invoice_sent?: boolean
          notify_email_overdue?: boolean
          notify_email_payment_received?: boolean
          notify_email_visit_completed?: boolean
          notify_email_weather_reschedule?: boolean
          notify_email_welcome?: boolean
          overdue_reminder_days?: number
          overdue_reminders_enabled?: boolean
          plan_status?: Database["public"]["Enums"]["org_plan_status"]
          public_signup_enabled?: boolean
          referral_reward_cents?: number
          review_ask_enabled?: boolean
          review_ask_template?: string | null
          slug?: string | null
          sms_from_number?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          active_client_count?: number
          ai_receptionist_enabled?: boolean
          ai_receptionist_faq?: string | null
          ai_receptionist_persona?: string | null
          ai_voice_enabled?: boolean
          ai_voice_greeting?: string | null
          auto_generate_days_ahead?: number
          auto_generate_visits?: boolean
          auto_invoice_enabled?: boolean
          billing_tier?: string | null
          created_at?: string
          currency?: string
          current_period_end?: string | null
          frequency_multipliers?: Json
          google_review_url?: string | null
          id?: string
          name?: string
          notify_email_invoice_sent?: boolean
          notify_email_overdue?: boolean
          notify_email_payment_received?: boolean
          notify_email_visit_completed?: boolean
          notify_email_weather_reschedule?: boolean
          notify_email_welcome?: boolean
          overdue_reminder_days?: number
          overdue_reminders_enabled?: boolean
          plan_status?: Database["public"]["Enums"]["org_plan_status"]
          public_signup_enabled?: boolean
          referral_reward_cents?: number
          review_ask_enabled?: boolean
          review_ask_template?: string | null
          slug?: string | null
          sms_from_number?: string | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
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
          aggressive_dog: boolean
          bees_wasps: boolean
          city: string
          client_id: string
          country: string | null
          created_at: string
          do_not_enter_if_dog_out: boolean
          dog_in_yard_during_service: boolean
          escape_risk: boolean
          gate_code: string | null
          hazard_notes: string | null
          id: string
          invisible_fence: boolean
          key_location: string | null
          label: string | null
          lock_box_code: string | null
          organization_id: string
          parking_notes: string | null
          postal_code: string
          region: string | null
          sharp_objects: boolean
          slippery_surfaces: boolean
          street: string
          yard_size: string | null
        }
        Insert: {
          access_notes?: string | null
          aggressive_dog?: boolean
          bees_wasps?: boolean
          city: string
          client_id: string
          country?: string | null
          created_at?: string
          do_not_enter_if_dog_out?: boolean
          dog_in_yard_during_service?: boolean
          escape_risk?: boolean
          gate_code?: string | null
          hazard_notes?: string | null
          id?: string
          invisible_fence?: boolean
          key_location?: string | null
          label?: string | null
          lock_box_code?: string | null
          organization_id: string
          parking_notes?: string | null
          postal_code: string
          region?: string | null
          sharp_objects?: boolean
          slippery_surfaces?: boolean
          street: string
          yard_size?: string | null
        }
        Update: {
          access_notes?: string | null
          aggressive_dog?: boolean
          bees_wasps?: boolean
          city?: string
          client_id?: string
          country?: string | null
          created_at?: string
          do_not_enter_if_dog_out?: boolean
          dog_in_yard_during_service?: boolean
          escape_risk?: boolean
          gate_code?: string | null
          hazard_notes?: string | null
          id?: string
          invisible_fence?: boolean
          key_location?: string | null
          label?: string | null
          lock_box_code?: string | null
          organization_id?: string
          parking_notes?: string | null
          postal_code?: string
          region?: string | null
          sharp_objects?: boolean
          slippery_surfaces?: boolean
          street?: string
          yard_size?: string | null
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
      signup_requests: {
        Row: {
          city: string | null
          created_at: string
          currency: string
          dog_count: number
          email: string
          error_message: string | null
          frequency: string
          id: string
          initial_cleanup_cents: number
          name: string
          organization_id: string
          phone: string | null
          postal_code: string
          provisioned_client_id: string | null
          recurring_price_cents: number
          region: string | null
          status: string
          street: string
          stripe_checkout_session_id: string | null
          updated_at: string
          zone_id: string | null
        }
        Insert: {
          city?: string | null
          created_at?: string
          currency?: string
          dog_count: number
          email: string
          error_message?: string | null
          frequency: string
          id?: string
          initial_cleanup_cents: number
          name: string
          organization_id: string
          phone?: string | null
          postal_code: string
          provisioned_client_id?: string | null
          recurring_price_cents: number
          region?: string | null
          status?: string
          street: string
          stripe_checkout_session_id?: string | null
          updated_at?: string
          zone_id?: string | null
        }
        Update: {
          city?: string | null
          created_at?: string
          currency?: string
          dog_count?: number
          email?: string
          error_message?: string | null
          frequency?: string
          id?: string
          initial_cleanup_cents?: number
          name?: string
          organization_id?: string
          phone?: string | null
          postal_code?: string
          provisioned_client_id?: string | null
          recurring_price_cents?: number
          region?: string | null
          status?: string
          street?: string
          stripe_checkout_session_id?: string | null
          updated_at?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signup_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signup_requests_provisioned_client_id_fkey"
            columns: ["provisioned_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signup_requests_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "zones"
            referencedColumns: ["id"]
          },
        ]
      }
      skip_billing_rules: {
        Row: {
          billable_pct: number
          organization_id: string
          reason_code: Database["public"]["Enums"]["skip_reason_code"]
          updated_at: string
        }
        Insert: {
          billable_pct?: number
          organization_id: string
          reason_code: Database["public"]["Enums"]["skip_reason_code"]
          updated_at?: string
        }
        Update: {
          billable_pct?: number
          organization_id?: string
          reason_code?: Database["public"]["Enums"]["skip_reason_code"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "skip_billing_rules_organization_id_fkey"
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
          start_address: string | null
          start_latitude: number | null
          start_longitude: number | null
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
          start_address?: string | null
          start_latitude?: number | null
          start_longitude?: number | null
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
          start_address?: string | null
          start_latitude?: number | null
          start_longitude?: number | null
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
      station_service_logs: {
        Row: {
          bags_collected: number
          created_at: string
          id: string
          liner_replaced: boolean
          notes: string | null
          organization_id: string
          photo_url: string | null
          refill_bags_added: number
          serviced_at: string
          visit_id: string
          waste_station_id: string
        }
        Insert: {
          bags_collected?: number
          created_at?: string
          id?: string
          liner_replaced?: boolean
          notes?: string | null
          organization_id: string
          photo_url?: string | null
          refill_bags_added?: number
          serviced_at?: string
          visit_id: string
          waste_station_id: string
        }
        Update: {
          bags_collected?: number
          created_at?: string
          id?: string
          liner_replaced?: boolean
          notes?: string | null
          organization_id?: string
          photo_url?: string | null
          refill_bags_added?: number
          serviced_at?: string
          visit_id?: string
          waste_station_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "station_service_logs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "station_service_logs_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "station_service_logs_waste_station_id_fkey"
            columns: ["waste_station_id"]
            isOneToOne: false
            referencedRelation: "waste_stations"
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
          preferred_weekdays: number[] | null
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
          preferred_weekdays?: number[] | null
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
          preferred_weekdays?: number[] | null
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
      suppressed_emails: {
        Row: {
          created_at: string
          email: string
          id: string
          metadata: Json | null
          reason: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          metadata?: Json | null
          reason: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          metadata?: Json | null
          reason?: string
        }
        Relationships: []
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
          rescheduled_from: string | null
          scheduled_on: string
          sequence: number | null
          skip_billable: boolean
          skip_charge_cents: number
          skip_reason: string | null
          skip_reason_code:
            | Database["public"]["Enums"]["skip_reason_code"]
            | null
          started_at: string | null
          station_count_serviced: number
          status: Database["public"]["Enums"]["visit_status"]
          subscription_id: string
          updated_at: string
          weather_flagged: boolean
          weather_note: string | null
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
          rescheduled_from?: string | null
          scheduled_on: string
          sequence?: number | null
          skip_billable?: boolean
          skip_charge_cents?: number
          skip_reason?: string | null
          skip_reason_code?:
            | Database["public"]["Enums"]["skip_reason_code"]
            | null
          started_at?: string | null
          station_count_serviced?: number
          status?: Database["public"]["Enums"]["visit_status"]
          subscription_id: string
          updated_at?: string
          weather_flagged?: boolean
          weather_note?: string | null
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
          rescheduled_from?: string | null
          scheduled_on?: string
          sequence?: number | null
          skip_billable?: boolean
          skip_charge_cents?: number
          skip_reason?: string | null
          skip_reason_code?:
            | Database["public"]["Enums"]["skip_reason_code"]
            | null
          started_at?: string | null
          station_count_serviced?: number
          status?: Database["public"]["Enums"]["visit_status"]
          subscription_id?: string
          updated_at?: string
          weather_flagged?: boolean
          weather_note?: string | null
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
      waste_disposal_facilities: {
        Row: {
          active: boolean
          address: string | null
          created_at: string
          id: string
          name: string
          notes: string | null
          organization_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          address?: string | null
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          organization_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          address?: string | null
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "waste_disposal_facilities_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      waste_disposal_manifests: {
        Row: {
          bag_count: number | null
          created_at: string
          disposed_at: string
          disposed_on: string
          facility_id: string | null
          id: string
          notes: string | null
          organization_id: string
          photo_url: string | null
          staff_id: string | null
          ticket_number: string | null
          updated_at: string
          weight_lbs: number | null
        }
        Insert: {
          bag_count?: number | null
          created_at?: string
          disposed_at?: string
          disposed_on: string
          facility_id?: string | null
          id?: string
          notes?: string | null
          organization_id: string
          photo_url?: string | null
          staff_id?: string | null
          ticket_number?: string | null
          updated_at?: string
          weight_lbs?: number | null
        }
        Update: {
          bag_count?: number | null
          created_at?: string
          disposed_at?: string
          disposed_on?: string
          facility_id?: string | null
          id?: string
          notes?: string | null
          organization_id?: string
          photo_url?: string | null
          staff_id?: string | null
          ticket_number?: string | null
          updated_at?: string
          weight_lbs?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "waste_disposal_manifests_facility_id_fkey"
            columns: ["facility_id"]
            isOneToOne: false
            referencedRelation: "waste_disposal_facilities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waste_disposal_manifests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waste_disposal_manifests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      waste_stations: {
        Row: {
          active: boolean
          capacity_liners: number | null
          client_id: string
          created_at: string
          id: string
          label: string
          liner_size: string | null
          location_description: string | null
          organization_id: string
          property_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          capacity_liners?: number | null
          client_id: string
          created_at?: string
          id?: string
          label: string
          liner_size?: string | null
          location_description?: string | null
          organization_id: string
          property_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          capacity_liners?: number | null
          client_id?: string
          created_at?: string
          id?: string
          label?: string
          liner_size?: string | null
          location_description?: string | null
          organization_id?: string
          property_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "waste_stations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waste_stations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waste_stations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      zones: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"] | null
          base_price_cents: number
          created_at: string
          id: string
          initial_cleanup_cents: number
          latitude: number | null
          longitude: number | null
          name: string
          organization_id: string
          per_dog_addl_cents: number
          postal_prefix: string | null
          price_note: string | null
          zip_codes: string[]
        }
        Insert: {
          account_type?: Database["public"]["Enums"]["account_type"] | null
          base_price_cents?: number
          created_at?: string
          id?: string
          initial_cleanup_cents?: number
          latitude?: number | null
          longitude?: number | null
          name: string
          organization_id: string
          per_dog_addl_cents?: number
          postal_prefix?: string | null
          price_note?: string | null
          zip_codes?: string[]
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"] | null
          base_price_cents?: number
          created_at?: string
          id?: string
          initial_cleanup_cents?: number
          latitude?: number | null
          longitude?: number | null
          name?: string
          organization_id?: string
          per_dog_addl_cents?: number
          postal_prefix?: string | null
          price_note?: string | null
          zip_codes?: string[]
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
      admin_generate_invoices_for_org: {
        Args: { _org_id: string; _through: string }
        Returns: number
      }
      admin_generate_visits_through: {
        Args: { _org_id: string; _through: string }
        Returns: number
      }
      apply_referral_code: {
        Args: { _code: string; _new_client_id: string }
        Returns: Json
      }
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
      client_default_billing_cadence: {
        Args: { _client_id: string }
        Returns: string
      }
      complete_visit: { Args: { _visit_id: string }; Returns: undefined }
      create_addon_charge: {
        Args: {
          _addon_service_id: string
          _client_id: string
          _description?: string
          _note?: string
          _quantity?: number
          _source?: string
          _unit_price_cents?: number
          _visit_id?: string
        }
        Returns: string
      }
      default_skip_billable_pct: {
        Args: { _code: Database["public"]["Enums"]["skip_reason_code"] }
        Returns: number
      }
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      email_queue_dispatch: { Args: never; Returns: undefined }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      generate_addon_charges_through: {
        Args: { _org_id: string; _through: string }
        Returns: number
      }
      generate_invoice_for_client: {
        Args: { _client_id: string; _through: string }
        Returns: string
      }
      generate_invoices_for_org: {
        Args: { _org_id: string; _through: string }
        Returns: number
      }
      generate_prepaid_invoice: {
        Args: { _subscription_id: string; _visit_count: number }
        Returns: string
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
      haversine_km: {
        Args: { lat1: number; lat2: number; lon1: number; lon2: number }
        Returns: number
      }
      is_org_member: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      is_visit_tech: {
        Args: { _user_id: string; _visit_id: string }
        Returns: boolean
      }
      log_station_service: {
        Args: {
          _bags_collected?: number
          _liner_replaced?: boolean
          _notes?: string
          _photo_url?: string
          _refill_bags_added?: number
          _visit_id: string
          _waste_station_id: string
        }
        Returns: string
      }
      mark_review_asked: { Args: { _client_id: string }; Returns: boolean }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
      next_visit_date: {
        Args: {
          _freq: Database["public"]["Enums"]["service_frequency"]
          _from: string
        }
        Returns: string
      }
      optimize_route_for_day: {
        Args: {
          _day: string
          _org_id: string
          _reassign?: boolean
          _staff_id: string
        }
        Returns: number
      }
      org_can_add_client: { Args: { _org_id: string }; Returns: boolean }
      phone_digits: { Args: { _p: string }; Returns: string }
      portal_get_client: {
        Args: { _token: string }
        Returns: {
          account_type: string
          client_id: string
          credit_balance_cents: number
          display_name: string
          org_name: string
          organization_id: string
        }[]
      }
      portal_list_invoices: {
        Args: { _token: string }
        Returns: {
          invoice_id: string
          issued_at: string
          kind: string
          period_end: string
          period_start: string
          status: Database["public"]["Enums"]["invoice_status"]
          total_cents: number
        }[]
      }
      portal_list_prepaid_subscriptions: {
        Args: { _token: string }
        Returns: {
          frequency: Database["public"]["Enums"]["service_frequency"]
          price_cents: number
          property_label: string
          subscription_id: string
        }[]
      }
      portal_list_upcoming_visits: {
        Args: { _token: string }
        Returns: {
          city: string
          postal_code: string
          scheduled_on: string
          status: Database["public"]["Enums"]["visit_status"]
          street: string
          visit_id: string
        }[]
      }
      portal_request_skip: {
        Args: { _reason: string; _token: string; _visit_id: string }
        Returns: undefined
      }
      portal_start_prepaid_topup: {
        Args: { _subscription_id: string; _token: string; _visit_count: number }
        Returns: string
      }
      post_credit_entry: {
        Args: {
          _client_id: string
          _delta: number
          _invoice_id: string
          _kind: string
          _note: string
          _org_id: string
          _visit_id: string
        }
        Returns: undefined
      }
      public_get_org_by_slug: {
        Args: { _slug: string }
        Returns: {
          currency: string
          id: string
          name: string
          public_signup_enabled: boolean
        }[]
      }
      public_quote: {
        Args: {
          _dog_count: number
          _frequency: string
          _postal_code: string
          _slug: string
        }
        Returns: {
          base_price_cents: number
          currency: string
          initial_cleanup_cents: number
          organization_id: string
          per_dog_addl_cents: number
          recurring_price_cents: number
          zone_id: string
          zone_name: string
        }[]
      }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
      reassign_visit: {
        Args: { _staff_id: string; _visit_id: string }
        Returns: undefined
      }
      refresh_active_client_count: {
        Args: { _org_id: string }
        Returns: undefined
      }
      reorder_route: {
        Args: { _day: string; _ordered_ids: string[]; _staff_id: string }
        Returns: number
      }
      reschedule_visit: {
        Args: { _new_date: string; _note?: string; _visit_id: string }
        Returns: undefined
      }
      skip_visit:
        | { Args: { _reason: string; _visit_id: string }; Returns: undefined }
        | {
            Args: {
              _code?: Database["public"]["Enums"]["skip_reason_code"]
              _reason: string
              _visit_id: string
            }
            Returns: undefined
          }
      start_visit: { Args: { _visit_id: string }; Returns: undefined }
      void_addon_charge: { Args: { _charge_id: string }; Returns: undefined }
      void_invoice: { Args: { _invoice_id: string }; Returns: undefined }
    }
    Enums: {
      account_type: "residential" | "commercial"
      addon_charge_status:
        | "pending"
        | "invoiced"
        | "paid_from_credit"
        | "voided"
      addon_frequency:
        | "weekly"
        | "biweekly"
        | "monthly"
        | "quarterly"
        | "yearly"
      addon_kind: "one_time" | "recurring"
      app_role: "owner" | "office_manager" | "dispatcher" | "tech"
      billing_cadence: "prepaid" | "postpaid"
      dog_temperament: "friendly" | "nervous" | "aggressive" | "unknown"
      import_row_action: "create" | "update" | "skip" | "error"
      import_source:
        | "generic_csv"
        | "sweepgo"
        | "jobber"
        | "housecall_pro"
        | "time_to_pet"
        | "gorilla_desk"
        | "quoteiq_family"
      import_status:
        | "draft"
        | "previewing"
        | "committed"
        | "failed"
        | "cancelled"
      invoice_kind: "postpaid" | "prepaid_topup"
      invoice_status: "draft" | "open" | "paid" | "void" | "uncollectible"
      message_direction: "outbound" | "inbound"
      message_status: "queued" | "sent" | "delivered" | "failed" | "received"
      org_plan_status: "free" | "active" | "past_due" | "canceled"
      payment_status: "pending" | "succeeded" | "failed" | "refunded"
      service_frequency:
        | "weekly"
        | "biweekly"
        | "twice_weekly"
        | "monthly"
        | "one_time"
      skip_reason_code:
        | "client_cancelled_late"
        | "gate_locked"
        | "dog_outside"
        | "weather"
        | "our_fault"
        | "access_blocked"
        | "unsafe_conditions"
        | "other"
        | "customer_requested"
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
      addon_charge_status: [
        "pending",
        "invoiced",
        "paid_from_credit",
        "voided",
      ],
      addon_frequency: ["weekly", "biweekly", "monthly", "quarterly", "yearly"],
      addon_kind: ["one_time", "recurring"],
      app_role: ["owner", "office_manager", "dispatcher", "tech"],
      billing_cadence: ["prepaid", "postpaid"],
      dog_temperament: ["friendly", "nervous", "aggressive", "unknown"],
      import_row_action: ["create", "update", "skip", "error"],
      import_source: [
        "generic_csv",
        "sweepgo",
        "jobber",
        "housecall_pro",
        "time_to_pet",
        "gorilla_desk",
        "quoteiq_family",
      ],
      import_status: [
        "draft",
        "previewing",
        "committed",
        "failed",
        "cancelled",
      ],
      invoice_kind: ["postpaid", "prepaid_topup"],
      invoice_status: ["draft", "open", "paid", "void", "uncollectible"],
      message_direction: ["outbound", "inbound"],
      message_status: ["queued", "sent", "delivered", "failed", "received"],
      org_plan_status: ["free", "active", "past_due", "canceled"],
      payment_status: ["pending", "succeeded", "failed", "refunded"],
      service_frequency: [
        "weekly",
        "biweekly",
        "twice_weekly",
        "monthly",
        "one_time",
      ],
      skip_reason_code: [
        "client_cancelled_late",
        "gate_locked",
        "dog_outside",
        "weather",
        "our_fault",
        "access_blocked",
        "unsafe_conditions",
        "other",
        "customer_requested",
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
