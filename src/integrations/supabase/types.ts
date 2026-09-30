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
      accounting_connections: {
        Row: {
          default_sales_tax_account: string | null
          access_token: string | null
          auto_sync: boolean
          connected_at: string
          created_at: string
          default_ar_account: string | null
          default_income_account: string | null
          default_payment_account: string | null
          id: string
          last_sync_at: string | null
          org_id: string
          provider: Database["public"]["Enums"]["accounting_provider"]
          realm_id: string | null
          refresh_token: string | null
          tenant_id: string | null
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          default_sales_tax_account?: string | null
          access_token?: string | null
          auto_sync?: boolean
          connected_at?: string
          created_at?: string
          default_ar_account?: string | null
          default_income_account?: string | null
          default_payment_account?: string | null
          id?: string
          last_sync_at?: string | null
          org_id: string
          provider: Database["public"]["Enums"]["accounting_provider"]
          realm_id?: string | null
          refresh_token?: string | null
          tenant_id?: string | null
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          default_sales_tax_account?: string | null
          access_token?: string | null
          auto_sync?: boolean
          connected_at?: string
          created_at?: string
          default_ar_account?: string | null
          default_income_account?: string | null
          default_payment_account?: string | null
          id?: string
          last_sync_at?: string | null
          org_id?: string
          provider?: Database["public"]["Enums"]["accounting_provider"]
          realm_id?: string | null
          refresh_token?: string | null
          tenant_id?: string | null
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounting_connections_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      accounting_sync_log: {
        Row: {
          connection_id: string | null
          created_at: string
          direction: Database["public"]["Enums"]["accounting_sync_direction"]
          entity_id: string
          entity_type: Database["public"]["Enums"]["accounting_entity_type"]
          id: string
          message: string | null
          org_id: string
          payload: Json | null
          remote_id: string | null
          status: Database["public"]["Enums"]["accounting_sync_status"]
        }
        Insert: {
          connection_id?: string | null
          created_at?: string
          direction: Database["public"]["Enums"]["accounting_sync_direction"]
          entity_id: string
          entity_type: Database["public"]["Enums"]["accounting_entity_type"]
          id?: string
          message?: string | null
          org_id: string
          payload?: Json | null
          remote_id?: string | null
          status: Database["public"]["Enums"]["accounting_sync_status"]
        }
        Update: {
          connection_id?: string | null
          created_at?: string
          direction?: Database["public"]["Enums"]["accounting_sync_direction"]
          entity_id?: string
          entity_type?: Database["public"]["Enums"]["accounting_entity_type"]
          id?: string
          message?: string | null
          org_id?: string
          payload?: Json | null
          remote_id?: string | null
          status?: Database["public"]["Enums"]["accounting_sync_status"]
        }
        Relationships: [
          {
            foreignKeyName: "accounting_sync_log_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "accounting_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounting_sync_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_log: {
        Row: {
          actor_label: string | null
          actor_user_id: string | null
          client_id: string | null
          created_at: string
          id: string
          kind: string
          meta: Json
          organization_id: string
          property_id: string | null
          subscription_id: string | null
          summary: string
        }
        Insert: {
          actor_label?: string | null
          actor_user_id?: string | null
          client_id?: string | null
          created_at?: string
          id?: string
          kind: string
          meta?: Json
          organization_id: string
          property_id?: string | null
          subscription_id?: string | null
          summary: string
        }
        Update: {
          actor_label?: string | null
          actor_user_id?: string | null
          client_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          meta?: Json
          organization_id?: string
          property_id?: string | null
          subscription_id?: string | null
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
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
          property_id: string | null
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
          property_id?: string | null
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
          property_id?: string | null
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
            foreignKeyName: "addon_charges_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
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
      addon_requests: {
        Row: {
          addon_service_id: string
          client_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decline_reason: string | null
          frequency: Database["public"]["Enums"]["addon_frequency"] | null
          id: string
          kind: Database["public"]["Enums"]["addon_kind"]
          organization_id: string
          property_id: string | null
          quantity: number
          status: string
          unit_price_cents: number
        }
        Insert: {
          addon_service_id: string
          client_id: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decline_reason?: string | null
          frequency?: Database["public"]["Enums"]["addon_frequency"] | null
          id?: string
          kind: Database["public"]["Enums"]["addon_kind"]
          organization_id: string
          property_id?: string | null
          quantity?: number
          status?: string
          unit_price_cents: number
        }
        Update: {
          addon_service_id?: string
          client_id?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decline_reason?: string | null
          frequency?: Database["public"]["Enums"]["addon_frequency"] | null
          id?: string
          kind?: Database["public"]["Enums"]["addon_kind"]
          organization_id?: string
          property_id?: string | null
          quantity?: number
          status?: string
          unit_price_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "addon_requests_addon_service_id_fkey"
            columns: ["addon_service_id"]
            isOneToOne: false
            referencedRelation: "addon_services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "addon_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "addon_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "addon_requests_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      addon_services: {
        Row: {
          active: boolean
          audience: Database["public"]["Enums"]["addon_audience"]
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
          audience?: Database["public"]["Enums"]["addon_audience"]
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
          audience?: Database["public"]["Enums"]["addon_audience"]
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
          property_id: string | null
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
          property_id?: string | null
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
          property_id?: string | null
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
          {
            foreignKeyName: "addon_subscriptions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
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
      ai_usage_events: {
        Row: {
          actions: number
          cost_micros: number
          created_at: string
          feature: string
          id: string
          input_tokens: number
          model: string | null
          occurred_at: string
          organization_id: string
          output_tokens: number
          over_allowance: boolean
          period_month: string
          provider: string
        }
        Insert: {
          actions?: number
          cost_micros?: number
          created_at?: string
          feature: string
          id?: string
          input_tokens?: number
          model?: string | null
          occurred_at?: string
          organization_id: string
          output_tokens?: number
          over_allowance?: boolean
          period_month: string
          provider: string
        }
        Update: {
          actions?: number
          cost_micros?: number
          created_at?: string
          feature?: string
          id?: string
          input_tokens?: number
          model?: string | null
          occurred_at?: string
          organization_id?: string
          output_tokens?: number
          over_allowance?: boolean
          period_month?: string
          provider?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_usage_periods: {
        Row: {
          actions: number
          billed_actions: number | null
          billed_at: string | null
          billed_cents: number | null
          cost_micros: number
          input_tokens: number
          organization_id: string
          output_tokens: number
          period_month: string
          stripe_invoice_item_id: string | null
          updated_at: string
          warned_at: string | null
        }
        Insert: {
          actions?: number
          billed_actions?: number | null
          billed_at?: string | null
          billed_cents?: number | null
          cost_micros?: number
          input_tokens?: number
          organization_id: string
          output_tokens?: number
          period_month: string
          stripe_invoice_item_id?: string | null
          updated_at?: string
          warned_at?: string | null
        }
        Update: {
          actions?: number
          billed_actions?: number | null
          billed_at?: string | null
          billed_cents?: number | null
          cost_micros?: number
          input_tokens?: number
          organization_id?: string
          output_tokens?: number
          period_month?: string
          stripe_invoice_item_id?: string | null
          updated_at?: string
          warned_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_periods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      app_notification_prefs: {
        Row: {
          muted_types: string[]
          updated_at: string
          user_id: string
        }
        Insert: {
          muted_types?: string[]
          updated_at?: string
          user_id: string
        }
        Update: {
          muted_types?: string[]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      app_notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          link: string | null
          organization_id: string
          read_at: string | null
          recipient_user_id: string
          title: string
          type: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          link?: string | null
          organization_id: string
          read_at?: string | null
          recipient_user_id: string
          title: string
          type: string
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          link?: string | null
          organization_id?: string
          read_at?: string | null
          recipient_user_id?: string
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_notifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
      calendar_feeds: {
        Row: {
          created_at: string
          id: string
          last_fetched_at: string | null
          organization_id: string
          scope: string
          token_hash: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_fetched_at?: string | null
          organization_id: string
          scope: string
          token_hash: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_fetched_at?: string | null
          organization_id?: string
          scope?: string
          token_hash?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_feeds_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      client_holds: {
        Row: {
          client_id: string
          created_at: string
          created_by: string | null
          ends_on: string
          id: string
          organization_id: string
          reason: string | null
          starts_on: string
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by?: string | null
          ends_on: string
          id?: string
          organization_id: string
          reason?: string | null
          starts_on: string
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string | null
          ends_on?: string
          id?: string
          organization_id?: string
          reason?: string | null
          starts_on?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_holds_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_holds_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      client_notes: {
        Row: {
          audience: string
          body: string
          client_id: string
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          pinned: boolean
          property_id: string | null
          updated_at: string
        }
        Insert: {
          audience: string
          body: string
          client_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          pinned?: boolean
          property_id?: string | null
          updated_at?: string
        }
        Update: {
          audience?: string
          body?: string
          client_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          pinned?: boolean
          property_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_notes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_notes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_notes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      client_unsubscribe_tokens: {
        Row: {
          client_id: string
          created_at: string
          id: string
          organization_id: string
          token: string
          used_at: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          organization_id: string
          token: string
          used_at?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          token?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_unsubscribe_tokens_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_unsubscribe_tokens_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          tax_exempt: boolean
          account_type: Database["public"]["Enums"]["account_type"]
          accounting_remote_id: string | null
          active: boolean
          autopay_enabled: boolean
          autopay_failure_count: number
          autopay_last_attempt_at: string | null
          autopay_last_error: string | null
          autopay_paused: boolean
          billing_frequency: string
          churn_reason: string | null
          churn_score: number | null
          churn_scored_at: string | null
          comms_paused: boolean
          company: string | null
          created_at: string
          credit_balance_cents: number
          default_card_brand: string | null
          default_card_last4: string | null
          default_payment_method_id: string | null
          display_name: string
          dna_compliance_enabled: boolean
          email_opt_out: boolean
          first_name: string | null
          id: string
          import_batch_id: string | null
          import_external_id: string | null
          import_source: Database["public"]["Enums"]["import_source"] | null
          last_name: string | null
          last_winback_sent_at: string | null
          notes: string | null
          organization_id: string
          portal_token: string
          preferred_contact: string | null
          primary_email: string | null
          primary_phone: string | null
          referral_applied_at: string | null
          referral_code: string | null
          referral_source: string | null
          referred_by_client_id: string | null
          review_asked_at: string | null
          review_submitted_at: string | null
          sms_consent_at: string | null
          sms_consent_phone: string | null
          sms_consent_source: string | null
          sms_consent_text: string | null
          sms_opt_out: boolean
          stripe_customer_id: string | null
          tags: string[]
          updated_at: string
        }
        Insert: {
          tax_exempt?: boolean
          account_type: Database["public"]["Enums"]["account_type"]
          accounting_remote_id?: string | null
          active?: boolean
          autopay_enabled?: boolean
          autopay_failure_count?: number
          autopay_last_attempt_at?: string | null
          autopay_last_error?: string | null
          autopay_paused?: boolean
          billing_frequency?: string
          churn_reason?: string | null
          churn_score?: number | null
          churn_scored_at?: string | null
          comms_paused?: boolean
          company?: string | null
          created_at?: string
          credit_balance_cents?: number
          default_card_brand?: string | null
          default_card_last4?: string | null
          default_payment_method_id?: string | null
          display_name: string
          dna_compliance_enabled?: boolean
          email_opt_out?: boolean
          first_name?: string | null
          id?: string
          import_batch_id?: string | null
          import_external_id?: string | null
          import_source?: Database["public"]["Enums"]["import_source"] | null
          last_name?: string | null
          last_winback_sent_at?: string | null
          notes?: string | null
          organization_id: string
          portal_token?: string
          preferred_contact?: string | null
          primary_email?: string | null
          primary_phone?: string | null
          referral_applied_at?: string | null
          referral_code?: string | null
          referral_source?: string | null
          referred_by_client_id?: string | null
          review_asked_at?: string | null
          review_submitted_at?: string | null
          sms_consent_at?: string | null
          sms_consent_phone?: string | null
          sms_consent_source?: string | null
          sms_consent_text?: string | null
          sms_opt_out?: boolean
          stripe_customer_id?: string | null
          tags?: string[]
          updated_at?: string
        }
        Update: {
          tax_exempt?: boolean
          account_type?: Database["public"]["Enums"]["account_type"]
          accounting_remote_id?: string | null
          active?: boolean
          autopay_enabled?: boolean
          autopay_failure_count?: number
          autopay_last_attempt_at?: string | null
          autopay_last_error?: string | null
          autopay_paused?: boolean
          billing_frequency?: string
          churn_reason?: string | null
          churn_score?: number | null
          churn_scored_at?: string | null
          comms_paused?: boolean
          company?: string | null
          created_at?: string
          credit_balance_cents?: number
          default_card_brand?: string | null
          default_card_last4?: string | null
          default_payment_method_id?: string | null
          display_name?: string
          dna_compliance_enabled?: boolean
          email_opt_out?: boolean
          first_name?: string | null
          id?: string
          import_batch_id?: string | null
          import_external_id?: string | null
          import_source?: Database["public"]["Enums"]["import_source"] | null
          last_name?: string | null
          last_winback_sent_at?: string | null
          notes?: string | null
          organization_id?: string
          portal_token?: string
          preferred_contact?: string | null
          primary_email?: string | null
          primary_phone?: string | null
          referral_applied_at?: string | null
          referral_code?: string | null
          referral_source?: string | null
          referred_by_client_id?: string | null
          review_asked_at?: string | null
          review_submitted_at?: string | null
          sms_consent_at?: string | null
          sms_consent_phone?: string | null
          sms_consent_source?: string | null
          sms_consent_text?: string | null
          sms_opt_out?: boolean
          stripe_customer_id?: string | null
          tags?: string[]
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
          promo_code_id: string | null
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
          promo_code_id?: string | null
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
          promo_code_id?: string | null
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
            foreignKeyName: "credit_ledger_promo_code_id_fkey"
            columns: ["promo_code_id"]
            isOneToOne: false
            referencedRelation: "promo_codes"
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
      dna_matches: {
        Row: {
          client_id: string | null
          collected_at: string
          collected_by_staff_id: string | null
          created_at: string
          created_by: string | null
          dna_provider: string | null
          fine_cents: number
          id: string
          kit_reference: string | null
          lab_reference: string | null
          location_note: string | null
          matched_at: string | null
          matched_dog_id: string | null
          notes: string | null
          organization_id: string
          property_id: string | null
          report_reference: string | null
          sample_kind: string
          sample_photo_path: string | null
          status: string
          unit_id: string | null
          updated_at: string
        }
        Insert: {
          client_id?: string | null
          collected_at?: string
          collected_by_staff_id?: string | null
          created_at?: string
          created_by?: string | null
          dna_provider?: string | null
          fine_cents?: number
          id?: string
          kit_reference?: string | null
          lab_reference?: string | null
          location_note?: string | null
          matched_at?: string | null
          matched_dog_id?: string | null
          notes?: string | null
          organization_id: string
          property_id?: string | null
          report_reference?: string | null
          sample_kind: string
          sample_photo_path?: string | null
          status?: string
          unit_id?: string | null
          updated_at?: string
        }
        Update: {
          client_id?: string | null
          collected_at?: string
          collected_by_staff_id?: string | null
          created_at?: string
          created_by?: string | null
          dna_provider?: string | null
          fine_cents?: number
          id?: string
          kit_reference?: string | null
          lab_reference?: string | null
          location_note?: string | null
          matched_at?: string | null
          matched_dog_id?: string | null
          notes?: string | null
          organization_id?: string
          property_id?: string | null
          report_reference?: string | null
          sample_kind?: string
          sample_photo_path?: string | null
          status?: string
          unit_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dna_matches_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dna_matches_collected_by_staff_id_fkey"
            columns: ["collected_by_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dna_matches_matched_dog_id_fkey"
            columns: ["matched_dog_id"]
            isOneToOne: false
            referencedRelation: "dogs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dna_matches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dna_matches_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dna_matches_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "property_units"
            referencedColumns: ["id"]
          },
        ]
      }
      dogs: {
        Row: {
          active: boolean
          breed: string | null
          created_at: string
          dna_kit_reference: string | null
          dna_provider: string | null
          dna_registered: boolean
          dna_registry_id: string | null
          dna_status: string
          id: string
          name: string
          notes: string | null
          organization_id: string
          property_id: string
          temperament: Database["public"]["Enums"]["dog_temperament"]
          unit_id: string | null
          unit_review_needed: boolean
          weight_class: string | null
        }
        Insert: {
          active?: boolean
          breed?: string | null
          created_at?: string
          dna_kit_reference?: string | null
          dna_provider?: string | null
          dna_registered?: boolean
          dna_registry_id?: string | null
          dna_status?: string
          id?: string
          name: string
          notes?: string | null
          organization_id: string
          property_id: string
          temperament?: Database["public"]["Enums"]["dog_temperament"]
          unit_id?: string | null
          unit_review_needed?: boolean
          weight_class?: string | null
        }
        Update: {
          active?: boolean
          breed?: string | null
          created_at?: string
          dna_kit_reference?: string | null
          dna_provider?: string | null
          dna_registered?: boolean
          dna_registry_id?: string | null
          dna_status?: string
          id?: string
          name?: string
          notes?: string | null
          organization_id?: string
          property_id?: string
          temperament?: Database["public"]["Enums"]["dog_temperament"]
          unit_id?: string | null
          unit_review_needed?: boolean
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
          {
            foreignKeyName: "dogs_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "property_units"
            referencedColumns: ["id"]
          },
        ]
      }
      email_campaign_recipients: {
        Row: {
          campaign_id: string
          claimed_at: string | null
          client_id: string
          created_at: string
          email: string
          id: string
          message_id: string | null
          organization_id: string
          queued_at: string | null
          skip_reason: string | null
          status: string
        }
        Insert: {
          campaign_id: string
          claimed_at?: string | null
          client_id: string
          created_at?: string
          email: string
          id?: string
          message_id?: string | null
          organization_id: string
          queued_at?: string | null
          skip_reason?: string | null
          status?: string
        }
        Update: {
          campaign_id?: string
          claimed_at?: string | null
          client_id?: string
          created_at?: string
          email?: string
          id?: string
          message_id?: string | null
          organization_id?: string
          queued_at?: string | null
          skip_reason?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_campaign_recipients_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "email_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaign_recipients_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_campaign_recipients_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      email_campaigns: {
        Row: {
          audience_kind: string
          audience_tag: string | null
          body: string
          button_label: string | null
          button_url: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          heading: string
          id: string
          organization_id: string
          recipient_count: number | null
          sent_at: string | null
          sent_by: string | null
          status: string
          subject: string
          updated_at: string
        }
        Insert: {
          audience_kind?: string
          audience_tag?: string | null
          body?: string
          button_label?: string | null
          button_url?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          heading?: string
          id?: string
          organization_id: string
          recipient_count?: number | null
          sent_at?: string | null
          sent_by?: string | null
          status?: string
          subject?: string
          updated_at?: string
        }
        Update: {
          audience_kind?: string
          audience_tag?: string | null
          body?: string
          button_label?: string | null
          button_url?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          heading?: string
          id?: string
          organization_id?: string
          recipient_count?: number | null
          sent_at?: string | null
          sent_by?: string | null
          status?: string
          subject?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_campaigns_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
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
      email_verifications: {
        Row: {
          created_at: string
          email: string
          expires_at: string
          id: string
          organization_id: string
          token: string
          user_id: string
          verified_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          organization_id: string
          token?: string
          user_id: string
          verified_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          organization_id?: string
          token?: string
          user_id?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_verifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      franchise_adjustments: {
        Row: {
          amount_cents: number
          applied_settlement_id: string | null
          child_organization_id: string
          collected_by_organization_id: string | null
          created_at: string
          cumulative_cents: number | null
          dispute_ref: string | null
          due_by: string
          franchise_share_cents: number
          id: string
          kind: string
          location_share_cents: number
          note: string | null
          original_period_end: string | null
          original_period_start: string | null
          parent_organization_id: string
          payment_id: string | null
          reversed_at: string | null
          reversed_by_adjustment_id: string | null
          status: string
        }
        Insert: {
          amount_cents: number
          applied_settlement_id?: string | null
          child_organization_id: string
          collected_by_organization_id?: string | null
          created_at?: string
          cumulative_cents?: number | null
          dispute_ref?: string | null
          due_by?: string
          franchise_share_cents?: number
          id?: string
          kind: string
          location_share_cents?: number
          note?: string | null
          original_period_end?: string | null
          original_period_start?: string | null
          parent_organization_id: string
          payment_id?: string | null
          reversed_at?: string | null
          reversed_by_adjustment_id?: string | null
          status?: string
        }
        Update: {
          amount_cents?: number
          applied_settlement_id?: string | null
          child_organization_id?: string
          collected_by_organization_id?: string | null
          created_at?: string
          cumulative_cents?: number | null
          dispute_ref?: string | null
          due_by?: string
          franchise_share_cents?: number
          id?: string
          kind?: string
          location_share_cents?: number
          note?: string | null
          original_period_end?: string | null
          original_period_start?: string | null
          parent_organization_id?: string
          payment_id?: string | null
          reversed_at?: string | null
          reversed_by_adjustment_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "franchise_adjustments_applied_settlement_id_fkey"
            columns: ["applied_settlement_id"]
            isOneToOne: false
            referencedRelation: "franchise_royalty_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "franchise_adjustments_child_organization_id_fkey"
            columns: ["child_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "franchise_adjustments_collected_by_organization_id_fkey"
            columns: ["collected_by_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "franchise_adjustments_parent_organization_id_fkey"
            columns: ["parent_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "franchise_adjustments_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "franchise_adjustments_reversed_by_adjustment_id_fkey"
            columns: ["reversed_by_adjustment_id"]
            isOneToOne: false
            referencedRelation: "franchise_adjustments"
            referencedColumns: ["id"]
          },
        ]
      }
      franchise_link_codes: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          expires_at: string
          id: string
          parent_organization_id: string
          revoked_at: string | null
          used_at: string | null
          used_by_org_id: string | null
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          parent_organization_id: string
          revoked_at?: string | null
          used_at?: string | null
          used_by_org_id?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          parent_organization_id?: string
          revoked_at?: string | null
          used_at?: string | null
          used_by_org_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "franchise_link_codes_parent_organization_id_fkey"
            columns: ["parent_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "franchise_link_codes_used_by_org_id_fkey"
            columns: ["used_by_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      franchise_royalty_invoices: {
        Row: {
          sales_tax_collected_by_parent_cents: number
          adjustments_applied_cents: number
          amount_cents: number
          child_organization_id: string
          created_at: string
          created_by: string | null
          direction: string
          id: string
          net_due_cents: number
          parent_organization_id: string
          period_end: string
          period_start: string
          revenue_cents: number
          revenue_collected_by_location_cents: number
          revenue_collected_by_parent_cents: number
          royalty_cents: number
          royalty_percent: number
          status: string
        }
        Insert: {
          sales_tax_collected_by_parent_cents?: number
          adjustments_applied_cents?: number
          amount_cents?: number
          child_organization_id: string
          created_at?: string
          created_by?: string | null
          direction?: string
          id?: string
          net_due_cents?: number
          parent_organization_id: string
          period_end: string
          period_start: string
          revenue_cents?: number
          revenue_collected_by_location_cents?: number
          revenue_collected_by_parent_cents?: number
          royalty_cents?: number
          royalty_percent?: number
          status?: string
        }
        Update: {
          sales_tax_collected_by_parent_cents?: number
          adjustments_applied_cents?: number
          amount_cents?: number
          child_organization_id?: string
          created_at?: string
          created_by?: string | null
          direction?: string
          id?: string
          net_due_cents?: number
          parent_organization_id?: string
          period_end?: string
          period_start?: string
          revenue_cents?: number
          revenue_collected_by_location_cents?: number
          revenue_collected_by_parent_cents?: number
          royalty_cents?: number
          royalty_percent?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "franchise_royalty_invoices_child_organization_id_fkey"
            columns: ["child_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "franchise_royalty_invoices_parent_organization_id_fkey"
            columns: ["parent_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      gift_card_redemptions: {
        Row: {
          amount_cents: number
          client_id: string | null
          created_at: string
          created_by: string | null
          gift_card_id: string
          id: string
          invoice_id: string | null
          note: string | null
          organization_id: string
        }
        Insert: {
          amount_cents: number
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          gift_card_id: string
          id?: string
          invoice_id?: string | null
          note?: string | null
          organization_id: string
        }
        Update: {
          amount_cents?: number
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          gift_card_id?: string
          id?: string
          invoice_id?: string | null
          note?: string | null
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "gift_card_redemptions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gift_card_redemptions_gift_card_id_fkey"
            columns: ["gift_card_id"]
            isOneToOne: false
            referencedRelation: "gift_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gift_card_redemptions_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gift_card_redemptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      gift_cards: {
        Row: {
          code: string
          created_at: string
          expires_at: string | null
          id: string
          initial_balance_cents: number
          message: string | null
          organization_id: string
          purchaser_email: string | null
          purchaser_name: string | null
          recipient_email: string | null
          recipient_name: string | null
          remaining_balance_cents: number
          status: string
          stripe_payment_intent_id: string | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          expires_at?: string | null
          id?: string
          initial_balance_cents: number
          message?: string | null
          organization_id: string
          purchaser_email?: string | null
          purchaser_name?: string | null
          recipient_email?: string | null
          recipient_name?: string | null
          remaining_balance_cents: number
          status?: string
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          initial_balance_cents?: number
          message?: string | null
          organization_id?: string
          purchaser_email?: string | null
          purchaser_name?: string | null
          recipient_email?: string | null
          recipient_name?: string | null
          remaining_balance_cents?: number
          status?: string
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gift_cards_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      impersonation_grants: {
        Row: {
          actor_user_id: string
          auth_session_id: string | null
          consumed_at: string | null
          created_at: string
          ended_at: string | null
          expires_at: string
          id: string
          organization_id: string
          session_expires_at: string | null
          target_user_id: string
          token_hash: string
        }
        Insert: {
          actor_user_id: string
          auth_session_id?: string | null
          consumed_at?: string | null
          created_at?: string
          ended_at?: string | null
          expires_at: string
          id?: string
          organization_id: string
          session_expires_at?: string | null
          target_user_id: string
          token_hash: string
        }
        Update: {
          actor_user_id?: string
          auth_session_id?: string | null
          consumed_at?: string | null
          created_at?: string
          ended_at?: string | null
          expires_at?: string
          id?: string
          organization_id?: string
          session_expires_at?: string | null
          target_user_id?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "impersonation_grants_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
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
      inventory_assignments: {
        Row: {
          created_at: string
          id: string
          item_id: string
          organization_id: string
          quantity: number
          staff_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          item_id: string
          organization_id: string
          quantity?: number
          staff_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          item_id?: string
          organization_id?: string
          quantity?: number
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_assignments_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_assignments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_items: {
        Row: {
          active: boolean
          category: string | null
          created_at: string
          id: string
          name: string
          notes: string | null
          on_hand: number
          organization_id: string
          reorder_threshold: number
          sku: string | null
          unit: string
          unit_cost_cents: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          category?: string | null
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          on_hand?: number
          organization_id: string
          reorder_threshold?: number
          sku?: string | null
          unit?: string
          unit_cost_cents?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          category?: string | null
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          on_hand?: number
          organization_id?: string
          reorder_threshold?: number
          sku?: string | null
          unit?: string
          unit_cost_cents?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_movements: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          item_id: string
          kind: string
          note: string | null
          organization_id: string
          quantity: number
          staff_id: string | null
          visit_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          item_id: string
          kind: string
          note?: string | null
          organization_id: string
          quantity: number
          staff_id?: string | null
          visit_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          item_id?: string
          kind?: string
          note?: string | null
          organization_id?: string
          quantity?: number
          staff_id?: string | null
          visit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_movements_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_movements_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
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
          quantity: number
          subscription_id: string | null
          unit_amount_cents: number | null
          visit_id: string | null
        }
        Insert: {
          amount_cents: number
          created_at?: string
          description: string
          id?: string
          invoice_id: string
          quantity?: number
          subscription_id?: string | null
          unit_amount_cents?: number | null
          visit_id?: string | null
        }
        Update: {
          amount_cents?: number
          created_at?: string
          description?: string
          id?: string
          invoice_id?: string
          quantity?: number
          subscription_id?: string | null
          unit_amount_cents?: number | null
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
          tax_cents: number
          tax_label: string | null
          tax_rate_bps: number
          accounting_remote_id: string | null
          checkout_url: string | null
          client_id: string
          created_at: string
          credit_applied_cents: number
          currency: string
          due_on: string | null
          id: string
          issued_at: string | null
          kind: Database["public"]["Enums"]["invoice_kind"]
          last_email_reminder_at: string | null
          last_reminder_at: string | null
          notes: string | null
          number: number
          organization_id: string
          paid_at: string | null
          period_end: string
          period_start: string | null
          public_token: string
          send_after: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["invoice_status"]
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          subtotal_cents: number
          total_cents: number
          updated_at: string
          voided_at: string | null
        }
        Insert: {
          tax_cents?: number
          tax_label?: string | null
          tax_rate_bps?: number
          accounting_remote_id?: string | null
          checkout_url?: string | null
          client_id: string
          created_at?: string
          credit_applied_cents?: number
          currency?: string
          due_on?: string | null
          id?: string
          issued_at?: string | null
          kind?: Database["public"]["Enums"]["invoice_kind"]
          last_email_reminder_at?: string | null
          last_reminder_at?: string | null
          notes?: string | null
          number?: number
          organization_id: string
          paid_at?: string | null
          period_end: string
          period_start?: string | null
          public_token?: string
          send_after?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          subtotal_cents?: number
          total_cents?: number
          updated_at?: string
          voided_at?: string | null
        }
        Update: {
          tax_cents?: number
          tax_label?: string | null
          tax_rate_bps?: number
          accounting_remote_id?: string | null
          checkout_url?: string | null
          client_id?: string
          created_at?: string
          credit_applied_cents?: number
          currency?: string
          due_on?: string | null
          id?: string
          issued_at?: string | null
          kind?: Database["public"]["Enums"]["invoice_kind"]
          last_email_reminder_at?: string | null
          last_reminder_at?: string | null
          notes?: string | null
          number?: number
          organization_id?: string
          paid_at?: string | null
          period_end?: string
          period_start?: string | null
          public_token?: string
          send_after?: string | null
          sent_at?: string | null
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
          converted_client_id: string | null
          created_at: string
          dog_count: number | null
          email: string
          frequency: string | null
          id: string
          location: string | null
          message: string | null
          name: string
          organization_id: string | null
          phone: string | null
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          company?: string | null
          contacted_at?: string | null
          converted_at?: string | null
          converted_client_id?: string | null
          created_at?: string
          dog_count?: number | null
          email: string
          frequency?: string | null
          id?: string
          location?: string | null
          message?: string | null
          name: string
          organization_id?: string | null
          phone?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Update: {
          company?: string | null
          contacted_at?: string | null
          converted_at?: string | null
          converted_client_id?: string | null
          created_at?: string
          dog_count?: number | null
          email?: string
          frequency?: string | null
          id?: string
          location?: string | null
          message?: string | null
          name?: string
          organization_id?: string | null
          phone?: string | null
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_converted_client_id_fkey"
            columns: ["converted_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_organization_id_fkey"
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
      neighbor_leads: {
        Row: {
          address_line: string
          contacted_at: string | null
          created_at: string
          created_by: string | null
          id: string
          latitude: number | null
          longitude: number | null
          notes: string | null
          organization_id: string
          seed_client_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          address_line: string
          contacted_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          notes?: string | null
          organization_id: string
          seed_client_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          address_line?: string
          contacted_at?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          latitude?: number | null
          longitude?: number | null
          notes?: string | null
          organization_id?: string
          seed_client_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "neighbor_leads_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "neighbor_leads_seed_client_id_fkey"
            columns: ["seed_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_states: {
        Row: {
          created_at: string
          expires_at: string
          org_id: string
          provider: string
          redirect_to: string | null
          state: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          org_id: string
          provider: string
          redirect_to?: string | null
          state: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          org_id?: string
          provider?: string
          redirect_to?: string | null
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_states_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          organization_id: string
          role: Database["public"]["Enums"]["app_role"]
          status: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          organization_id: string
          role: Database["public"]["Enums"]["app_role"]
          status?: string
          token: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          organization_id?: string
          role?: Database["public"]["Enums"]["app_role"]
          status?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_invites_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_platform_addons: {
        Row: {
          addon_id: string
          canceled_at: string | null
          created_at: string
          organization_id: string
          status: string
          stripe_subscription_item_id: string | null
        }
        Insert: {
          addon_id: string
          canceled_at?: string | null
          created_at?: string
          organization_id: string
          status?: string
          stripe_subscription_item_id?: string | null
        }
        Update: {
          addon_id?: string
          canceled_at?: string | null
          created_at?: string
          organization_id?: string
          status?: string
          stripe_subscription_item_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "org_platform_addons_addon_id_fkey"
            columns: ["addon_id"]
            isOneToOne: false
            referencedRelation: "platform_addons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_platform_addons_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_twilio_credentials: {
        Row: {
          account_sid: string
          auth_token: string
          messaging_service_sid: string | null
          organization_id: string
          sms_from_number: string | null
          token_last4: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          account_sid: string
          auth_token: string
          messaging_service_sid?: string | null
          organization_id: string
          sms_from_number?: string | null
          token_last4?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          account_sid?: string
          auth_token?: string
          messaging_service_sid?: string | null
          organization_id?: string
          sms_from_number?: string | null
          token_last4?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "org_twilio_credentials_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          sales_tax_label: string
          sales_tax_rate_bps: number
          active_client_count: number
          active_seat_count: number
          ai_hard_cap_multiplier: number
          ai_receptionist_enabled: boolean
          ai_receptionist_faq: string | null
          ai_receptionist_persona: string | null
          ai_voice_enabled: boolean
          ai_voice_greeting: string | null
          area_type: string
          auto_generate_days_ahead: number
          auto_generate_visits: boolean
          auto_invoice_enabled: boolean
          avg_speed_kmh: number | null
          billing_status: Database["public"]["Enums"]["org_billing_status"]
          billing_tier: string | null
          brand_color: string | null
          card_surcharge_attested_at: string | null
          chargeback_responsibility: string
          commercial_accounts: boolean
          contact_address: string | null
          contact_email: string | null
          contact_phone: string | null
          created_at: string
          currency: string
          current_period_end: string | null
          deleted_at: string | null
          digest_recipient_email: string | null
          disputes_in_analytics: boolean
          dunning_pause_after_failures: number
          dunning_retry_days: number[]
          email_verified_at: string | null
          est_time_config: Json | null
          field_addon_cap_cents: number
          franchise_royalty_percent: number
          frequency_multipliers: Json
          google_review_url: string | null
          grace_expires_at: string | null
          id: string
          invoice_grace_days: number
          invoice_net_days: number
          is_comped: boolean
          is_franchise_parent: boolean
          last_digest_sent_at: string | null
          latitude: number | null
          lead_form_config: Json
          logo_url: string | null
          longitude: number | null
          max_drive_minutes: number
          measured_at: string | null
          measured_legs: number | null
          measured_road_factor: number | null
          measured_speed_kmh: number | null
          name: string
          next_invoice_number: number
          next_quote_number: number
          notify_email_invoice_sent: boolean
          notify_email_overdue: boolean
          notify_email_payment_received: boolean
          notify_email_quote_sent: boolean
          notify_email_review_request: boolean
          notify_email_visit_completed: boolean
          notify_email_visit_reminder: boolean
          require_completion_photo: boolean
          visit_checklist: Json
          email_visit_checklist: boolean
          notify_email_weather_reschedule: boolean
          notify_email_weekly_digest: boolean
          notify_email_welcome: boolean
          notify_email_win_back: boolean
          notify_schedule_horizon: boolean
          notify_sms_on_my_way: boolean
          notify_sms_overdue_invoice: boolean
          notify_sms_payment_failed: boolean
          notify_sms_visit_completed: boolean
          notify_sms_visit_reminder: boolean
          onboarding_dismissed_at: string | null
          overdue_reminder_days: number
          overdue_reminders_enabled: boolean
          parent_organization_id: string | null
          park_walk_min: number
          payment_fee_pass_through: boolean
          tips_enabled: boolean
          payments_collected_by_parent: boolean
          plan_id: string | null
          plan_status: Database["public"]["Enums"]["org_plan_status"]
          portal_allow_frequency_change: boolean
          portal_allow_self_reschedule: boolean
          portal_allow_vacation_hold: boolean
          portal_auto_apply_changes: boolean
          portal_reschedule_cutoff_hours: number
          portal_slug: string | null
          public_signup_enabled: boolean
          reclean_window_hours: number
          calendar_feed_access_codes: boolean
          one_off_price_cents: number | null
          portal_auto_accept_bookings: boolean
          referral_code: string | null
          referral_reward_cents: number
          referred_by_org_id: string | null
          review_ask_enabled: boolean
          review_ask_template: string | null
          road_factor: number
          schedule_horizon_notified_on: string | null
          seasonal_deepclean_charge_cents: number
          seasonal_deepclean_enabled: boolean
          seasonal_deepclean_months: number[]
          signup_promo_code: string | null
          signup_ref_code: string | null
          signup_utm: Json | null
          slug: string | null
          sms_consent_at: string | null
          sms_consent_phone: string | null
          sms_consent_text: string | null
          sms_from_number: string | null
          std_base_price_cents: number | null
          std_per_dog_addl_cents: number | null
          stripe_connect_account_id: string | null
          stripe_connect_charges_enabled: boolean
          stripe_connect_connected_at: string | null
          stripe_connect_status: string | null
          stripe_customer_id: string | null
          stripe_merchant_region: string | null
          stripe_subscription_id: string | null
          suspended_at: string | null
          suspended_reason: string | null
          timezone: string
          traffic_profile: string
          trial_ends_at: string | null
          updated_at: string
          work_days: number[]
          workday_end: string
          workday_start: string
          notify_email_on_my_way: boolean
          on_my_way_on_navigate: boolean
          quote_followup_days: number
        }
        Insert: {
          sales_tax_label?: string
          sales_tax_rate_bps?: number
          active_client_count?: number
          active_seat_count?: number
          ai_hard_cap_multiplier?: number
          ai_receptionist_enabled?: boolean
          ai_receptionist_faq?: string | null
          ai_receptionist_persona?: string | null
          ai_voice_enabled?: boolean
          ai_voice_greeting?: string | null
          area_type?: string
          auto_generate_days_ahead?: number
          auto_generate_visits?: boolean
          auto_invoice_enabled?: boolean
          avg_speed_kmh?: number | null
          billing_status?: Database["public"]["Enums"]["org_billing_status"]
          billing_tier?: string | null
          brand_color?: string | null
          card_surcharge_attested_at?: string | null
          chargeback_responsibility?: string
          commercial_accounts?: boolean
          contact_address?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          currency?: string
          current_period_end?: string | null
          deleted_at?: string | null
          digest_recipient_email?: string | null
          disputes_in_analytics?: boolean
          dunning_pause_after_failures?: number
          dunning_retry_days?: number[]
          email_verified_at?: string | null
          est_time_config?: Json | null
          field_addon_cap_cents?: number
          franchise_royalty_percent?: number
          frequency_multipliers?: Json
          google_review_url?: string | null
          grace_expires_at?: string | null
          id?: string
          invoice_grace_days?: number
          invoice_net_days?: number
          is_comped?: boolean
          is_franchise_parent?: boolean
          last_digest_sent_at?: string | null
          latitude?: number | null
          lead_form_config?: Json
          logo_url?: string | null
          longitude?: number | null
          max_drive_minutes?: number
          measured_at?: string | null
          measured_legs?: number | null
          measured_road_factor?: number | null
          measured_speed_kmh?: number | null
          name: string
          next_invoice_number?: number
          next_quote_number?: number
          notify_email_invoice_sent?: boolean
          notify_email_overdue?: boolean
          notify_email_payment_received?: boolean
          notify_email_quote_sent?: boolean
          notify_email_review_request?: boolean
          notify_email_visit_completed?: boolean
          notify_email_visit_reminder?: boolean
          require_completion_photo?: boolean
          visit_checklist?: Json
          email_visit_checklist?: boolean
          notify_email_weather_reschedule?: boolean
          notify_email_weekly_digest?: boolean
          notify_email_welcome?: boolean
          notify_email_win_back?: boolean
          notify_schedule_horizon?: boolean
          notify_sms_on_my_way?: boolean
          notify_sms_overdue_invoice?: boolean
          notify_sms_payment_failed?: boolean
          notify_sms_visit_completed?: boolean
          notify_sms_visit_reminder?: boolean
          onboarding_dismissed_at?: string | null
          overdue_reminder_days?: number
          overdue_reminders_enabled?: boolean
          parent_organization_id?: string | null
          park_walk_min?: number
          payment_fee_pass_through?: boolean
          tips_enabled?: boolean
          payments_collected_by_parent?: boolean
          plan_id?: string | null
          plan_status?: Database["public"]["Enums"]["org_plan_status"]
          portal_allow_frequency_change?: boolean
          portal_allow_self_reschedule?: boolean
          portal_allow_vacation_hold?: boolean
          portal_auto_apply_changes?: boolean
          portal_reschedule_cutoff_hours?: number
          portal_slug?: string | null
          public_signup_enabled?: boolean
          reclean_window_hours?: number
          calendar_feed_access_codes?: boolean
          one_off_price_cents?: number | null
          portal_auto_accept_bookings?: boolean
          referral_code?: string | null
          referral_reward_cents?: number
          referred_by_org_id?: string | null
          review_ask_enabled?: boolean
          review_ask_template?: string | null
          road_factor?: number
          schedule_horizon_notified_on?: string | null
          seasonal_deepclean_charge_cents?: number
          seasonal_deepclean_enabled?: boolean
          seasonal_deepclean_months?: number[]
          signup_promo_code?: string | null
          signup_ref_code?: string | null
          signup_utm?: Json | null
          slug?: string | null
          sms_consent_at?: string | null
          sms_consent_phone?: string | null
          sms_consent_text?: string | null
          sms_from_number?: string | null
          std_base_price_cents?: number | null
          std_per_dog_addl_cents?: number | null
          stripe_connect_account_id?: string | null
          stripe_connect_charges_enabled?: boolean
          stripe_connect_connected_at?: string | null
          stripe_connect_status?: string | null
          stripe_customer_id?: string | null
          stripe_merchant_region?: string | null
          stripe_subscription_id?: string | null
          suspended_at?: string | null
          suspended_reason?: string | null
          timezone?: string
          traffic_profile?: string
          trial_ends_at?: string | null
          updated_at?: string
          work_days?: number[]
          workday_end?: string
          workday_start?: string
          notify_email_on_my_way?: boolean
          on_my_way_on_navigate?: boolean
          quote_followup_days?: number
        }
        Update: {
          sales_tax_label?: string
          sales_tax_rate_bps?: number
          active_client_count?: number
          active_seat_count?: number
          ai_hard_cap_multiplier?: number
          ai_receptionist_enabled?: boolean
          ai_receptionist_faq?: string | null
          ai_receptionist_persona?: string | null
          ai_voice_enabled?: boolean
          ai_voice_greeting?: string | null
          area_type?: string
          auto_generate_days_ahead?: number
          auto_generate_visits?: boolean
          auto_invoice_enabled?: boolean
          avg_speed_kmh?: number | null
          billing_status?: Database["public"]["Enums"]["org_billing_status"]
          billing_tier?: string | null
          brand_color?: string | null
          card_surcharge_attested_at?: string | null
          chargeback_responsibility?: string
          commercial_accounts?: boolean
          contact_address?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          currency?: string
          current_period_end?: string | null
          deleted_at?: string | null
          digest_recipient_email?: string | null
          disputes_in_analytics?: boolean
          dunning_pause_after_failures?: number
          dunning_retry_days?: number[]
          email_verified_at?: string | null
          est_time_config?: Json | null
          field_addon_cap_cents?: number
          franchise_royalty_percent?: number
          frequency_multipliers?: Json
          google_review_url?: string | null
          grace_expires_at?: string | null
          id?: string
          invoice_grace_days?: number
          invoice_net_days?: number
          is_comped?: boolean
          is_franchise_parent?: boolean
          last_digest_sent_at?: string | null
          latitude?: number | null
          lead_form_config?: Json
          logo_url?: string | null
          longitude?: number | null
          max_drive_minutes?: number
          measured_at?: string | null
          measured_legs?: number | null
          measured_road_factor?: number | null
          measured_speed_kmh?: number | null
          name?: string
          next_invoice_number?: number
          next_quote_number?: number
          notify_email_invoice_sent?: boolean
          notify_email_overdue?: boolean
          notify_email_payment_received?: boolean
          notify_email_quote_sent?: boolean
          notify_email_review_request?: boolean
          notify_email_visit_completed?: boolean
          notify_email_visit_reminder?: boolean
          require_completion_photo?: boolean
          visit_checklist?: Json
          email_visit_checklist?: boolean
          notify_email_weather_reschedule?: boolean
          notify_email_weekly_digest?: boolean
          notify_email_welcome?: boolean
          notify_email_win_back?: boolean
          notify_schedule_horizon?: boolean
          notify_sms_on_my_way?: boolean
          notify_sms_overdue_invoice?: boolean
          notify_sms_payment_failed?: boolean
          notify_sms_visit_completed?: boolean
          notify_sms_visit_reminder?: boolean
          onboarding_dismissed_at?: string | null
          overdue_reminder_days?: number
          overdue_reminders_enabled?: boolean
          parent_organization_id?: string | null
          park_walk_min?: number
          payment_fee_pass_through?: boolean
          tips_enabled?: boolean
          payments_collected_by_parent?: boolean
          plan_id?: string | null
          plan_status?: Database["public"]["Enums"]["org_plan_status"]
          portal_allow_frequency_change?: boolean
          portal_allow_self_reschedule?: boolean
          portal_allow_vacation_hold?: boolean
          portal_auto_apply_changes?: boolean
          portal_reschedule_cutoff_hours?: number
          portal_slug?: string | null
          public_signup_enabled?: boolean
          reclean_window_hours?: number
          calendar_feed_access_codes?: boolean
          one_off_price_cents?: number | null
          portal_auto_accept_bookings?: boolean
          referral_code?: string | null
          referral_reward_cents?: number
          referred_by_org_id?: string | null
          review_ask_enabled?: boolean
          review_ask_template?: string | null
          road_factor?: number
          schedule_horizon_notified_on?: string | null
          seasonal_deepclean_charge_cents?: number
          seasonal_deepclean_enabled?: boolean
          seasonal_deepclean_months?: number[]
          signup_promo_code?: string | null
          signup_ref_code?: string | null
          signup_utm?: Json | null
          slug?: string | null
          sms_consent_at?: string | null
          sms_consent_phone?: string | null
          sms_consent_text?: string | null
          sms_from_number?: string | null
          std_base_price_cents?: number | null
          std_per_dog_addl_cents?: number | null
          stripe_connect_account_id?: string | null
          stripe_connect_charges_enabled?: boolean
          stripe_connect_connected_at?: string | null
          stripe_connect_status?: string | null
          stripe_customer_id?: string | null
          stripe_merchant_region?: string | null
          stripe_subscription_id?: string | null
          suspended_at?: string | null
          suspended_reason?: string | null
          timezone?: string
          traffic_profile?: string
          trial_ends_at?: string | null
          updated_at?: string
          work_days?: number[]
          workday_end?: string
          workday_start?: string
          notify_email_on_my_way?: boolean
          on_my_way_on_navigate?: boolean
          quote_followup_days?: number
        }
        Relationships: [
          {
            foreignKeyName: "organizations_parent_organization_id_fkey"
            columns: ["parent_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizations_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "platform_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizations_referred_by_org_id_fkey"
            columns: ["referred_by_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          tax_cents: number
          accounting_remote_id: string | null
          amount_cents: number
          collected_by_organization_id: string | null
          created_at: string
          currency: string
          id: string
          invoice_id: string
          method: string | null
          organization_id: string
          paid_at: string | null
          raw_event: Json | null
          reference: string | null
          status: Database["public"]["Enums"]["payment_status"]
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          surcharge_cents: number
          tip_cents: number
          tip_staff_id: string | null
          updated_at: string
        }
        Insert: {
          tax_cents?: number
          accounting_remote_id?: string | null
          amount_cents: number
          collected_by_organization_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          invoice_id: string
          method?: string | null
          organization_id: string
          paid_at?: string | null
          raw_event?: Json | null
          reference?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          surcharge_cents?: number
          tip_cents?: number
          tip_staff_id?: string | null
          updated_at?: string
        }
        Update: {
          tax_cents?: number
          accounting_remote_id?: string | null
          amount_cents?: number
          collected_by_organization_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          invoice_id?: string
          method?: string | null
          organization_id?: string
          paid_at?: string | null
          raw_event?: Json | null
          reference?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          surcharge_cents?: number
          tip_cents?: number
          tip_staff_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_collected_by_organization_id_fkey"
            columns: ["collected_by_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
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
          {
            foreignKeyName: "payments_tip_staff_id_fkey"
            columns: ["tip_staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_addons: {
        Row: {
          billing_interval: string
          created_at: string
          description: string | null
          feature_flag: string | null
          id: string
          is_active: boolean
          name: string
          price_cents: number
          slug: string
          sort_order: number
          status: string
          stripe_price_id: string | null
          stripe_product_id: string | null
          updated_at: string
        }
        Insert: {
          billing_interval?: string
          created_at?: string
          description?: string | null
          feature_flag?: string | null
          id?: string
          is_active?: boolean
          name: string
          price_cents: number
          slug: string
          sort_order?: number
          status?: string
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          updated_at?: string
        }
        Update: {
          billing_interval?: string
          created_at?: string
          description?: string | null
          feature_flag?: string | null
          id?: string
          is_active?: boolean
          name?: string
          price_cents?: number
          slug?: string
          sort_order?: number
          status?: string
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      platform_admin_audit: {
        Row: {
          action: string
          actor_user_id: string | null
          after_json: Json | null
          before_json: Json | null
          created_at: string
          id: string
          organization_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          after_json?: Json | null
          before_json?: Json | null
          created_at?: string
          id?: string
          organization_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          after_json?: Json | null
          before_json?: Json | null
          created_at?: string
          id?: string
          organization_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_admin_audit_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_admins: {
        Row: {
          granted_at: string
          granted_by: string | null
          user_id: string
        }
        Insert: {
          granted_at?: string
          granted_by?: string | null
          user_id: string
        }
        Update: {
          granted_at?: string
          granted_by?: string | null
          user_id?: string
        }
        Relationships: []
      }
      platform_announcement_reads: {
        Row: {
          announcement_id: string
          read_at: string
          user_id: string
        }
        Insert: {
          announcement_id: string
          read_at?: string
          user_id: string
        }
        Update: {
          announcement_id?: string
          read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_announcement_reads_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "platform_announcements"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_announcements: {
        Row: {
          audience: string
          body: string
          created_at: string
          created_by: string | null
          email_sent_at: string | null
          ends_at: string | null
          id: string
          send_email: boolean
          severity: string
          starts_at: string
          title: string
          updated_at: string
        }
        Insert: {
          audience?: string
          body: string
          created_at?: string
          created_by?: string | null
          email_sent_at?: string | null
          ends_at?: string | null
          id?: string
          send_email?: boolean
          severity?: string
          starts_at?: string
          title: string
          updated_at?: string
        }
        Update: {
          audience?: string
          body?: string
          created_at?: string
          created_by?: string | null
          email_sent_at?: string | null
          ends_at?: string | null
          id?: string
          send_email?: boolean
          severity?: string
          starts_at?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      platform_coupons: {
        Row: {
          amount_off_cents: number | null
          applies_to_plan_ids: string[]
          code: string
          created_at: string
          created_by: string | null
          currency: string
          duration: string
          duration_in_months: number | null
          expires_at: string | null
          id: string
          is_active: boolean
          max_redemptions: number | null
          percent_off: number | null
          stripe_coupon_id: string | null
          times_redeemed: number
          updated_at: string
        }
        Insert: {
          amount_off_cents?: number | null
          applies_to_plan_ids?: string[]
          code: string
          created_at?: string
          created_by?: string | null
          currency?: string
          duration?: string
          duration_in_months?: number | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_redemptions?: number | null
          percent_off?: number | null
          stripe_coupon_id?: string | null
          times_redeemed?: number
          updated_at?: string
        }
        Update: {
          amount_off_cents?: number | null
          applies_to_plan_ids?: string[]
          code?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          duration?: string
          duration_in_months?: number | null
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_redemptions?: number | null
          percent_off?: number | null
          stripe_coupon_id?: string | null
          times_redeemed?: number
          updated_at?: string
        }
        Relationships: []
      }
      platform_feature_flags: {
        Row: {
          created_at: string
          default_value: boolean
          description: string | null
          id: string
          key: string
          label: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          default_value?: boolean
          description?: string | null
          id?: string
          key: string
          label: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          default_value?: boolean
          description?: string | null
          id?: string
          key?: string
          label?: string
          updated_at?: string
        }
        Relationships: []
      }
      platform_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          organization_id: string | null
          organization_name: string | null
          revoked_at: string | null
          role: string
          token: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          organization_id?: string | null
          organization_name?: string | null
          revoked_at?: string | null
          role?: string
          token: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          organization_id?: string | null
          organization_name?: string | null
          revoked_at?: string | null
          role?: string
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_invites_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_invoices: {
        Row: {
          amount_due_cents: number
          amount_paid_cents: number
          created_at: string
          currency: string
          due_at: string | null
          hosted_invoice_url: string | null
          id: string
          invoice_pdf: string | null
          issued_at: string | null
          number: string | null
          organization_id: string
          paid_at: string | null
          period_end: string | null
          period_start: string | null
          refunded_at: string | null
          refunded_cents: number
          status: string
          stripe_invoice_id: string | null
          stripe_payment_intent_id: string | null
          updated_at: string
        }
        Insert: {
          amount_due_cents?: number
          amount_paid_cents?: number
          created_at?: string
          currency?: string
          due_at?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_pdf?: string | null
          issued_at?: string | null
          number?: string | null
          organization_id: string
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          refunded_at?: string | null
          refunded_cents?: number
          status?: string
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_due_cents?: number
          amount_paid_cents?: number
          created_at?: string
          currency?: string
          due_at?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_pdf?: string | null
          issued_at?: string | null
          number?: string | null
          organization_id?: string
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          refunded_at?: string | null
          refunded_cents?: number
          status?: string
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_invoices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_org_feature_flags: {
        Row: {
          justification: string | null
          key: string
          organization_id: string
          updated_at: string
          updated_by: string | null
          value: boolean
        }
        Insert: {
          justification?: string | null
          key: string
          organization_id: string
          updated_at?: string
          updated_by?: string | null
          value: boolean
        }
        Update: {
          justification?: string | null
          key?: string
          organization_id?: string
          updated_at?: string
          updated_by?: string | null
          value?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "platform_org_feature_flags_key_fkey"
            columns: ["key"]
            isOneToOne: false
            referencedRelation: "platform_feature_flags"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "platform_org_feature_flags_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_plans: {
        Row: {
          ai_actions_included: number | null
          ai_overage_cents_per_action: number | null
          annual_price_cents: number | null
          client_limit_max: number | null
          client_limit_min: number
          created_at: string
          currency: string
          description: string | null
          entitlement_tier: string
          features: Json
          id: string
          included_seats: number | null
          interval: string
          is_active: boolean
          is_enterprise: boolean
          is_free: boolean
          name: string
          price_cents: number | null
          price_per_client_cents: number | null
          price_per_seat_cents: number | null
          slug: string
          sort_order: number
          stripe_annual_price_id: string | null
          stripe_annual_seat_price_id: string | null
          stripe_price_id: string | null
          stripe_product_id: string | null
          stripe_seat_price_id: string | null
          updated_at: string
        }
        Insert: {
          ai_actions_included?: number | null
          ai_overage_cents_per_action?: number | null
          annual_price_cents?: number | null
          client_limit_max?: number | null
          client_limit_min: number
          created_at?: string
          currency?: string
          description?: string | null
          entitlement_tier: string
          features?: Json
          id?: string
          included_seats?: number | null
          interval?: string
          is_active?: boolean
          is_enterprise?: boolean
          is_free?: boolean
          name: string
          price_cents?: number | null
          price_per_client_cents?: number | null
          price_per_seat_cents?: number | null
          slug: string
          sort_order?: number
          stripe_annual_price_id?: string | null
          stripe_annual_seat_price_id?: string | null
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          stripe_seat_price_id?: string | null
          updated_at?: string
        }
        Update: {
          ai_actions_included?: number | null
          ai_overage_cents_per_action?: number | null
          annual_price_cents?: number | null
          client_limit_max?: number | null
          client_limit_min?: number
          created_at?: string
          currency?: string
          description?: string | null
          entitlement_tier?: string
          features?: Json
          id?: string
          included_seats?: number | null
          interval?: string
          is_active?: boolean
          is_enterprise?: boolean
          is_free?: boolean
          name?: string
          price_cents?: number | null
          price_per_client_cents?: number | null
          price_per_seat_cents?: number | null
          slug?: string
          sort_order?: number
          stripe_annual_price_id?: string | null
          stripe_annual_seat_price_id?: string | null
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          stripe_seat_price_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      platform_referral_settings: {
        Row: {
          holding_days: number
          id: boolean
          reward_percent: number
          updated_at: string
          volume_flag_threshold: number
        }
        Insert: {
          holding_days?: number
          id?: boolean
          reward_percent?: number
          updated_at?: string
          volume_flag_threshold?: number
        }
        Update: {
          holding_days?: number
          id?: boolean
          reward_percent?: number
          updated_at?: string
          volume_flag_threshold?: number
        }
        Relationships: []
      }
      platform_signup_requests: {
        Row: {
          approx_client_count: number | null
          contact_email: string
          contact_name: string
          contact_phone: string | null
          created_at: string
          created_invite_id: string | null
          denial_reason: string | null
          id: string
          ip_address: string | null
          notes: string | null
          organization_name: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
          user_agent: string | null
          website: string | null
        }
        Insert: {
          approx_client_count?: number | null
          contact_email: string
          contact_name: string
          contact_phone?: string | null
          created_at?: string
          created_invite_id?: string | null
          denial_reason?: string | null
          id?: string
          ip_address?: string | null
          notes?: string | null
          organization_name: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          user_agent?: string | null
          website?: string | null
        }
        Update: {
          approx_client_count?: number | null
          contact_email?: string
          contact_name?: string
          contact_phone?: string | null
          created_at?: string
          created_invite_id?: string | null
          denial_reason?: string | null
          id?: string
          ip_address?: string | null
          notes?: string | null
          organization_name?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          user_agent?: string | null
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "platform_signup_requests_created_invite_id_fkey"
            columns: ["created_invite_id"]
            isOneToOne: false
            referencedRelation: "platform_invites"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_stripe_events: {
        Row: {
          error: string | null
          id: string
          payload: Json
          processed_at: string | null
          received_at: string
          type: string
        }
        Insert: {
          error?: string | null
          id: string
          payload: Json
          processed_at?: string | null
          received_at?: string
          type: string
        }
        Update: {
          error?: string | null
          id?: string
          payload?: Json
          processed_at?: string | null
          received_at?: string
          type?: string
        }
        Relationships: []
      }
      platform_support_notes: {
        Row: {
          author_user_id: string | null
          body: string
          created_at: string
          id: string
          kind: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          author_user_id?: string | null
          body: string
          created_at?: string
          id?: string
          kind?: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          author_user_id?: string | null
          body?: string
          created_at?: string
          id?: string
          kind?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_support_notes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_code_attempts: {
        Row: {
          created_at: string
          id: string
          ip: unknown
          organization_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          ip?: unknown
          organization_id: string
        }
        Update: {
          created_at?: string
          id?: string
          ip?: unknown
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "portal_code_attempts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_otps: {
        Row: {
          attempts: number
          channel: string
          client_id: string
          code_hash: string
          consumed_at: string | null
          created_at: string
          destination_hint: string | null
          expires_at: string
          id: string
          request_ip: unknown
        }
        Insert: {
          attempts?: number
          channel: string
          client_id: string
          code_hash: string
          consumed_at?: string | null
          created_at?: string
          destination_hint?: string | null
          expires_at: string
          id?: string
          request_ip?: unknown
        }
        Update: {
          attempts?: number
          channel?: string
          client_id?: string
          code_hash?: string
          consumed_at?: string | null
          created_at?: string
          destination_hint?: string | null
          expires_at?: string
          id?: string
          request_ip?: unknown
        }
        Relationships: [
          {
            foreignKeyName: "portal_otps_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_sessions: {
        Row: {
          client_id: string
          created_at: string
          expires_at: string
          id: string
          ip: unknown
          last_seen_at: string
          organization_id: string
          preview_by: string | null
          revoked_at: string | null
          token_hash: string
          user_agent: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          expires_at: string
          id?: string
          ip?: unknown
          last_seen_at?: string
          organization_id: string
          preview_by?: string | null
          revoked_at?: string | null
          token_hash: string
          user_agent?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          ip?: unknown
          last_seen_at?: string
          organization_id?: string
          preview_by?: string | null
          revoked_at?: string | null
          token_hash?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "portal_sessions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portal_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      promo_codes: {
        Row: {
          active: boolean
          applies_to: string
          code: string
          created_at: string
          created_by: string | null
          description: string | null
          discount_percent: number | null
          discount_type: string
          discount_value_cents: number | null
          expires_at: string | null
          id: string
          max_redemptions: number | null
          organization_id: string
          recurring_cycles: number | null
          redemption_count: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          applies_to?: string
          code: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          discount_percent?: number | null
          discount_type: string
          discount_value_cents?: number | null
          expires_at?: string | null
          id?: string
          max_redemptions?: number | null
          organization_id: string
          recurring_cycles?: number | null
          redemption_count?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          applies_to?: string
          code?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          discount_percent?: number | null
          discount_type?: string
          discount_value_cents?: number | null
          expires_at?: string | null
          id?: string
          max_redemptions?: number | null
          organization_id?: string
          recurring_cycles?: number | null
          redemption_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "promo_codes_organization_id_fkey"
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
          account_type: Database["public"]["Enums"]["account_type"] | null
          address_source: string | null
          aggressive_dog: boolean
          archived_at: string | null
          auto_zone_id: string | null
          bees_wasps: boolean
          boundary: Json | null
          boundary_area_sqm: number | null
          building_labels: string[] | null
          city: string
          client_id: string
          commercial_sections: string[] | null
          country: string | null
          created_at: string
          do_not_enter_if_dog_out: boolean
          dog_in_yard_during_service: boolean
          earliest_service_time: string | null
          escape_risk: boolean
          est_override_at: string | null
          est_override_by: string | null
          est_override_reason: string | null
          gate_code: string | null
          has_units: boolean
          hazard_notes: string | null
          id: string
          invisible_fence: boolean
          key_location: string | null
          label: string | null
          latest_service_time: string | null
          latitude: number | null
          lock_box_code: string | null
          longitude: number | null
          organization_id: string
          parking_notes: string | null
          postal_code: string
          region: string | null
          service_duration_min: number
          sharp_objects: boolean
          slippery_surfaces: boolean
          street: string
          total_units: number | null
          unit: string | null
          visit_contact_email: string | null
          visit_contact_name: string | null
          visit_contact_phone: string | null
          yard_size: string | null
          zone_id: string | null
          zone_override_by: string | null
          zone_override_reason: string | null
        }
        Insert: {
          access_notes?: string | null
          account_type?: Database["public"]["Enums"]["account_type"] | null
          address_source?: string | null
          aggressive_dog?: boolean
          archived_at?: string | null
          auto_zone_id?: string | null
          bees_wasps?: boolean
          boundary?: Json | null
          boundary_area_sqm?: number | null
          building_labels?: string[] | null
          city: string
          client_id: string
          commercial_sections?: string[] | null
          country?: string | null
          created_at?: string
          do_not_enter_if_dog_out?: boolean
          dog_in_yard_during_service?: boolean
          earliest_service_time?: string | null
          escape_risk?: boolean
          est_override_at?: string | null
          est_override_by?: string | null
          est_override_reason?: string | null
          gate_code?: string | null
          has_units?: boolean
          hazard_notes?: string | null
          id?: string
          invisible_fence?: boolean
          key_location?: string | null
          label?: string | null
          latest_service_time?: string | null
          latitude?: number | null
          lock_box_code?: string | null
          longitude?: number | null
          organization_id: string
          parking_notes?: string | null
          postal_code: string
          region?: string | null
          service_duration_min?: number
          sharp_objects?: boolean
          slippery_surfaces?: boolean
          street: string
          total_units?: number | null
          unit?: string | null
          visit_contact_email?: string | null
          visit_contact_name?: string | null
          visit_contact_phone?: string | null
          yard_size?: string | null
          zone_id?: string | null
          zone_override_by?: string | null
          zone_override_reason?: string | null
        }
        Update: {
          access_notes?: string | null
          account_type?: Database["public"]["Enums"]["account_type"] | null
          address_source?: string | null
          aggressive_dog?: boolean
          archived_at?: string | null
          auto_zone_id?: string | null
          bees_wasps?: boolean
          boundary?: Json | null
          boundary_area_sqm?: number | null
          building_labels?: string[] | null
          city?: string
          client_id?: string
          commercial_sections?: string[] | null
          country?: string | null
          created_at?: string
          do_not_enter_if_dog_out?: boolean
          dog_in_yard_during_service?: boolean
          earliest_service_time?: string | null
          escape_risk?: boolean
          est_override_at?: string | null
          est_override_by?: string | null
          est_override_reason?: string | null
          gate_code?: string | null
          has_units?: boolean
          hazard_notes?: string | null
          id?: string
          invisible_fence?: boolean
          key_location?: string | null
          label?: string | null
          latest_service_time?: string | null
          latitude?: number | null
          lock_box_code?: string | null
          longitude?: number | null
          organization_id?: string
          parking_notes?: string | null
          postal_code?: string
          region?: string | null
          service_duration_min?: number
          sharp_objects?: boolean
          slippery_surfaces?: boolean
          street?: string
          total_units?: number | null
          unit?: string | null
          visit_contact_email?: string | null
          visit_contact_name?: string | null
          visit_contact_phone?: string | null
          yard_size?: string | null
          zone_id?: string | null
          zone_override_by?: string | null
          zone_override_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "properties_auto_zone_id_fkey"
            columns: ["auto_zone_id"]
            isOneToOne: false
            referencedRelation: "zones"
            referencedColumns: ["id"]
          },
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
          {
            foreignKeyName: "properties_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "zones"
            referencedColumns: ["id"]
          },
        ]
      }
      property_units: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          offending_count: number
          organization_id: string
          property_id: string
          resident_email: string | null
          resident_name: string | null
          resident_phone: string | null
          unit_label: string
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          offending_count?: number
          organization_id: string
          property_id: string
          resident_email?: string | null
          resident_name?: string | null
          resident_phone?: string | null
          unit_label: string
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          offending_count?: number
          organization_id?: string
          property_id?: string
          resident_email?: string | null
          resident_name?: string | null
          resident_phone?: string | null
          unit_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_units_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_units_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string | null
          client_id: string | null
          created_at: string
          disabled: boolean
          endpoint: string | null
          id: string
          last_error: string | null
          last_sent_at: string | null
          native_token: string | null
          organization_id: string | null
          p256dh: string | null
          platform: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          auth?: string | null
          client_id?: string | null
          created_at?: string
          disabled?: boolean
          endpoint?: string | null
          id?: string
          last_error?: string | null
          last_sent_at?: string | null
          native_token?: string | null
          organization_id?: string | null
          p256dh?: string | null
          platform?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          auth?: string | null
          client_id?: string | null
          created_at?: string
          disabled?: boolean
          endpoint?: string | null
          id?: string
          last_error?: string | null
          last_sent_at?: string | null
          native_token?: string | null
          organization_id?: string | null
          p256dh?: string | null
          platform?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      qc_tickets: {
        Row: {
          category: string
          booked_visit_id: string | null
          client_id: string
          created_at: string
          id: string
          last_reply: string | null
          last_reply_at: string | null
          message: string | null
          organization_id: string
          property_id: string | null
          reclean_visit_id: string | null
          requested_on: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          updated_at: string
          visit_id: string | null
        }
        Insert: {
          category: string
          booked_visit_id?: string | null
          client_id: string
          created_at?: string
          id?: string
          last_reply?: string | null
          last_reply_at?: string | null
          message?: string | null
          organization_id: string
          property_id?: string | null
          reclean_visit_id?: string | null
          requested_on?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
          visit_id?: string | null
        }
        Update: {
          category?: string
          booked_visit_id?: string | null
          client_id?: string
          created_at?: string
          id?: string
          last_reply?: string | null
          last_reply_at?: string | null
          message?: string | null
          organization_id?: string
          property_id?: string | null
          reclean_visit_id?: string | null
          requested_on?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
          visit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "qc_tickets_booked_visit_id_fkey"
            columns: ["booked_visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qc_tickets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qc_tickets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qc_tickets_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qc_tickets_reclean_visit_id_fkey"
            columns: ["reclean_visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qc_tickets_visit_id_fkey"
            columns: ["visit_id"]
            isOneToOne: false
            referencedRelation: "visits"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_line_items: {
        Row: {
          amount_cents: number
          created_at: string
          description: string
          id: string
          quantity: number
          quote_id: string
          recurring: boolean
          sort: number
          unit_amount_cents: number
        }
        Insert: {
          amount_cents: number
          created_at?: string
          description: string
          id?: string
          quantity?: number
          quote_id: string
          recurring?: boolean
          sort?: number
          unit_amount_cents: number
        }
        Update: {
          amount_cents?: number
          created_at?: string
          description?: string
          id?: string
          quantity?: number
          quote_id?: string
          recurring?: boolean
          sort?: number
          unit_amount_cents?: number
        }
        Relationships: [
          {
            foreignKeyName: "quote_line_items_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quotes: {
        Row: {
          accepted_at: string | null
          accepted_name: string | null
          client_id: string | null
          converted_at: string | null
          converted_client_id: string | null
          created_at: string
          created_by: string | null
          decline_reason: string | null
          declined_at: string | null
          deposit_cents: number | null
          deposit_invoice_id: string | null
          id: string
          lead_id: string | null
          message: string | null
          number: number
          organization_id: string
          prospect_email: string | null
          prospect_name: string | null
          prospect_phone: string | null
          public_token: string
          sent_at: string | null
          status: string
          title: string | null
          updated_at: string
          valid_until: string | null
          followup_sent_at: string | null
          one_time_invoice_id: string | null
        }
        Insert: {
          accepted_at?: string | null
          accepted_name?: string | null
          client_id?: string | null
          converted_at?: string | null
          converted_client_id?: string | null
          created_at?: string
          created_by?: string | null
          decline_reason?: string | null
          declined_at?: string | null
          deposit_cents?: number | null
          deposit_invoice_id?: string | null
          id?: string
          lead_id?: string | null
          message?: string | null
          number?: number
          organization_id: string
          prospect_email?: string | null
          prospect_name?: string | null
          prospect_phone?: string | null
          public_token?: string
          sent_at?: string | null
          status?: string
          title?: string | null
          updated_at?: string
          valid_until?: string | null
          followup_sent_at?: string | null
          one_time_invoice_id?: string | null
        }
        Update: {
          accepted_at?: string | null
          accepted_name?: string | null
          client_id?: string | null
          converted_at?: string | null
          converted_client_id?: string | null
          created_at?: string
          created_by?: string | null
          decline_reason?: string | null
          declined_at?: string | null
          deposit_cents?: number | null
          deposit_invoice_id?: string | null
          id?: string
          lead_id?: string | null
          message?: string | null
          number?: number
          organization_id?: string
          prospect_email?: string | null
          prospect_name?: string | null
          prospect_phone?: string | null
          public_token?: string
          sent_at?: string | null
          status?: string
          title?: string | null
          updated_at?: string
          valid_until?: string | null
          followup_sent_at?: string | null
          one_time_invoice_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quotes_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_converted_client_id_fkey"
            columns: ["converted_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      review_items: {
        Row: {
          detail: Json
          detected_at: string
          dispute_ref: string
          id: string
          kind: string
          organization_id: string
          reason: string
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          subject_id: string
          subject_table: string
        }
        Insert: {
          detail?: Json
          detected_at?: string
          dispute_ref?: string
          id?: string
          kind: string
          organization_id: string
          reason: string
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          subject_id: string
          subject_table: string
        }
        Update: {
          detail?: Json
          detected_at?: string
          dispute_ref?: string
          id?: string
          kind?: string
          organization_id?: string
          reason?: string
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          subject_id?: string
          subject_table?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      road_legs: {
        Row: {
          fetched_at: string
          from_lat: number
          from_lon: number
          meters: number
          organization_id: string
          seconds: number
          source: string
          to_lat: number
          to_lon: number
        }
        Insert: {
          fetched_at?: string
          from_lat: number
          from_lon: number
          meters: number
          organization_id: string
          seconds: number
          source?: string
          to_lat: number
          to_lon: number
        }
        Update: {
          fetched_at?: string
          from_lat?: number
          from_lon?: number
          meters?: number
          organization_id?: string
          seconds?: number
          source?: string
          to_lat?: number
          to_lon?: number
        }
        Relationships: [
          {
            foreignKeyName: "road_legs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      roadmap_vote_throttle: {
        Row: {
          ip_hash: string
          votes: number
          window_started_at: string
        }
        Insert: {
          ip_hash: string
          votes?: number
          window_started_at?: string
        }
        Update: {
          ip_hash?: string
          votes?: number
          window_started_at?: string
        }
        Relationships: []
      }
      roadmap_votes: {
        Row: {
          created_at: string
          feature: string
          id: string
          voter_id: string
        }
        Insert: {
          created_at?: string
          feature: string
          id?: string
          voter_id: string
        }
        Update: {
          created_at?: string
          feature?: string
          id?: string
          voter_id?: string
        }
        Relationships: []
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
          refunded_amount_cents: number | null
          refunded_at: string | null
          region: string | null
          status: string
          street: string
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          stripe_refund_id: string | null
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
          refunded_amount_cents?: number | null
          refunded_at?: string | null
          region?: string | null
          status?: string
          street: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_refund_id?: string | null
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
          refunded_amount_cents?: number | null
          refunded_at?: string | null
          region?: string | null
          status?: string
          street?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_refund_id?: string | null
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
          avatar_url: string | null
          created_at: string
          daily_capacity_minutes: number | null
          display_name: string
          email: string | null
          end_address: string | null
          end_latitude: number | null
          end_longitude: number | null
          id: string
          is_field_tech: boolean
          is_field_tech_overridden: boolean
          location_id: string | null
          organization_id: string
          phone: string | null
          role: Database["public"]["Enums"]["staff_role"]
          routing_available: boolean
          start_address: string | null
          start_latitude: number | null
          start_longitude: number | null
          user_id: string
        }
        Insert: {
          active?: boolean
          avatar_url?: string | null
          created_at?: string
          daily_capacity_minutes?: number | null
          display_name: string
          email?: string | null
          end_address?: string | null
          end_latitude?: number | null
          end_longitude?: number | null
          id?: string
          is_field_tech?: boolean
          is_field_tech_overridden?: boolean
          location_id?: string | null
          organization_id: string
          phone?: string | null
          role: Database["public"]["Enums"]["staff_role"]
          routing_available?: boolean
          start_address?: string | null
          start_latitude?: number | null
          start_longitude?: number | null
          user_id: string
        }
        Update: {
          active?: boolean
          avatar_url?: string | null
          created_at?: string
          daily_capacity_minutes?: number | null
          display_name?: string
          email?: string | null
          end_address?: string | null
          end_latitude?: number | null
          end_longitude?: number | null
          id?: string
          is_field_tech?: boolean
          is_field_tech_overridden?: boolean
          location_id?: string | null
          organization_id?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["staff_role"]
          routing_available?: boolean
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
      staff_time_off: {
        Row: {
          created_at: string
          created_by: string | null
          ends_on: string
          id: string
          organization_id: string
          reason: string | null
          staff_id: string
          starts_on: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          ends_on: string
          id?: string
          organization_id: string
          reason?: string | null
          staff_id: string
          starts_on: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          ends_on?: string
          id?: string
          organization_id?: string
          reason?: string | null
          staff_id?: string
          starts_on?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_time_off_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_time_off_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
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
          earliest_time: string | null
          end_notes: string | null
          end_reason: string | null
          ended_by: string | null
          ends_on: string | null
          frequency: Database["public"]["Enums"]["service_frequency"]
          id: string
          interval_days: number | null
          interval_weeks: number | null
          latest_time: string | null
          organization_id: string
          paused_at: string | null
          preferred_time_of_day: string
          preferred_weekdays: number[] | null
          price_cents: number
          price_overridden_at: string | null
          priced_at: string | null
          priced_from_zone_id: string | null
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
          earliest_time?: string | null
          end_notes?: string | null
          end_reason?: string | null
          ended_by?: string | null
          ends_on?: string | null
          frequency: Database["public"]["Enums"]["service_frequency"]
          id?: string
          interval_days?: number | null
          interval_weeks?: number | null
          latest_time?: string | null
          organization_id: string
          paused_at?: string | null
          preferred_time_of_day?: string
          preferred_weekdays?: number[] | null
          price_cents: number
          price_overridden_at?: string | null
          priced_at?: string | null
          priced_from_zone_id?: string | null
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
          earliest_time?: string | null
          end_notes?: string | null
          end_reason?: string | null
          ended_by?: string | null
          ends_on?: string | null
          frequency?: Database["public"]["Enums"]["service_frequency"]
          id?: string
          interval_days?: number | null
          interval_weeks?: number | null
          latest_time?: string | null
          organization_id?: string
          paused_at?: string | null
          preferred_time_of_day?: string
          preferred_weekdays?: number[] | null
          price_cents?: number
          price_overridden_at?: string | null
          priced_at?: string | null
          priced_from_zone_id?: string | null
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
            foreignKeyName: "subscriptions_priced_from_zone_id_fkey"
            columns: ["priced_from_zone_id"]
            isOneToOne: false
            referencedRelation: "zones"
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
      tenant_referrals: {
        Row: {
          code_used: string
          converted_at: string | null
          created_at: string
          eligible_at: string | null
          first_payment_cents: number | null
          flag_reason: string | null
          flagged: boolean
          id: string
          paid_at: string | null
          paid_note: string | null
          referred_org_id: string
          referrer_org_id: string
          reward_cents: number | null
          reward_percent: number | null
          status: string
          updated_at: string
        }
        Insert: {
          code_used: string
          converted_at?: string | null
          created_at?: string
          eligible_at?: string | null
          first_payment_cents?: number | null
          flag_reason?: string | null
          flagged?: boolean
          id?: string
          paid_at?: string | null
          paid_note?: string | null
          referred_org_id: string
          referrer_org_id: string
          reward_cents?: number | null
          reward_percent?: number | null
          status?: string
          updated_at?: string
        }
        Update: {
          code_used?: string
          converted_at?: string | null
          created_at?: string
          eligible_at?: string | null
          first_payment_cents?: number | null
          flag_reason?: string | null
          flagged?: boolean
          id?: string
          paid_at?: string | null
          paid_note?: string | null
          referred_org_id?: string
          referrer_org_id?: string
          reward_cents?: number | null
          reward_percent?: number | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_referrals_referred_org_id_fkey"
            columns: ["referred_org_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_referrals_referrer_org_id_fkey"
            columns: ["referrer_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      time_entries: {
        Row: {
          clock_in: string
          clock_in_source: string
          clock_out: string | null
          clock_out_source: string | null
          created_at: string
          edited_at: string | null
          edited_by: string | null
          id: string
          note: string | null
          organization_id: string
          staff_id: string
          updated_at: string
        }
        Insert: {
          clock_in: string
          clock_in_source?: string
          clock_out?: string | null
          clock_out_source?: string | null
          created_at?: string
          edited_at?: string | null
          edited_by?: string | null
          id?: string
          note?: string | null
          organization_id: string
          staff_id: string
          updated_at?: string
        }
        Update: {
          clock_in?: string
          clock_in_source?: string
          clock_out?: string | null
          clock_out_source?: string | null
          created_at?: string
          edited_at?: string | null
          edited_by?: string | null
          id?: string
          note?: string | null
          organization_id?: string
          staff_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff"
            referencedColumns: ["id"]
          },
        ]
      }
      unit_incidents: {
        Row: {
          charged_cents: number | null
          created_at: string
          created_by: string | null
          dog_id: string | null
          id: string
          incident_on: string
          kind: string
          notes: string | null
          organization_id: string
          property_id: string
          unit_id: string
        }
        Insert: {
          charged_cents?: number | null
          created_at?: string
          created_by?: string | null
          dog_id?: string | null
          id?: string
          incident_on?: string
          kind: string
          notes?: string | null
          organization_id: string
          property_id: string
          unit_id: string
        }
        Update: {
          charged_cents?: number | null
          created_at?: string
          created_by?: string | null
          dog_id?: string | null
          id?: string
          incident_on?: string
          kind?: string
          notes?: string | null
          organization_id?: string
          property_id?: string
          unit_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "unit_incidents_dog_id_fkey"
            columns: ["dog_id"]
            isOneToOne: false
            referencedRelation: "dogs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unit_incidents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unit_incidents_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unit_incidents_unit_id_fkey"
            columns: ["unit_id"]
            isOneToOne: false
            referencedRelation: "property_units"
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
          completion_source: string | null
          created_at: string
          deepclean_charge_cents: number
          eta_end: string | null
          eta_start: string | null
          id: string
          is_deepclean: boolean
          organization_id: string
          price_cents: number | null
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
          skipped_at: string | null
          started_at: string | null
          station_count_serviced: number
          status: Database["public"]["Enums"]["visit_status"]
          subscription_id: string
          tech_note: string | null
          visit_checklist: Json | null
          completion_photo_waived_reason: string | null
          travel_km: number | null
          travel_min: number | null
          updated_at: string
          weather_flagged: boolean
          weather_note: string | null
          window_violated: boolean
          zone_id: string | null
          on_my_way_sent_at: string | null
          gate_reply: string | null
          gate_reply_at: string | null
        }
        Insert: {
          assigned_staff_id?: string | null
          client_id: string
          completed_at?: string | null
          completion_source?: string | null
          created_at?: string
          deepclean_charge_cents?: number
          eta_end?: string | null
          eta_start?: string | null
          id?: string
          is_deepclean?: boolean
          organization_id: string
          price_cents?: number | null
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
          skipped_at?: string | null
          started_at?: string | null
          station_count_serviced?: number
          status?: Database["public"]["Enums"]["visit_status"]
          subscription_id: string
          tech_note?: string | null
          visit_checklist?: Json | null
          completion_photo_waived_reason?: string | null
          travel_km?: number | null
          travel_min?: number | null
          updated_at?: string
          weather_flagged?: boolean
          weather_note?: string | null
          window_violated?: boolean
          zone_id?: string | null
          on_my_way_sent_at?: string | null
          gate_reply?: string | null
          gate_reply_at?: string | null
        }
        Update: {
          assigned_staff_id?: string | null
          client_id?: string
          completed_at?: string | null
          completion_source?: string | null
          created_at?: string
          deepclean_charge_cents?: number
          eta_end?: string | null
          eta_start?: string | null
          id?: string
          is_deepclean?: boolean
          organization_id?: string
          price_cents?: number | null
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
          skipped_at?: string | null
          started_at?: string | null
          station_count_serviced?: number
          status?: Database["public"]["Enums"]["visit_status"]
          subscription_id?: string
          tech_note?: string | null
          visit_checklist?: Json | null
          completion_photo_waived_reason?: string | null
          travel_km?: number | null
          travel_min?: number | null
          updated_at?: string
          weather_flagged?: boolean
          weather_note?: string | null
          window_violated?: boolean
          zone_id?: string | null
          on_my_way_sent_at?: string | null
          gate_reply?: string | null
          gate_reply_at?: string | null
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
          latitude: number | null
          longitude: number | null
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
          latitude?: number | null
          longitude?: number | null
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
          latitude?: number | null
          longitude?: number | null
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
          label: string | null
          latitude: number | null
          liner_size: string | null
          location_description: string | null
          longitude: number | null
          organization_id: string
          property_id: string
          section: string | null
          sort_order: number
          station_number: number | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          capacity_liners?: number | null
          client_id: string
          created_at?: string
          id?: string
          label?: string | null
          latitude?: number | null
          liner_size?: string | null
          location_description?: string | null
          longitude?: number | null
          organization_id: string
          property_id: string
          section?: string | null
          sort_order?: number
          station_number?: number | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          capacity_liners?: number | null
          client_id?: string
          created_at?: string
          id?: string
          label?: string | null
          latitude?: number | null
          liner_size?: string | null
          location_description?: string | null
          longitude?: number | null
          organization_id?: string
          property_id?: string
          section?: string | null
          sort_order?: number
          station_number?: number | null
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
      weather_forecast_cache: {
        Row: {
          fetched_at: string
          from_date: string
          id: string
          lat_key: number
          lon_key: number
          payload: Json
          to_date: string
          units: string
        }
        Insert: {
          fetched_at?: string
          from_date: string
          id?: string
          lat_key: number
          lon_key: number
          payload: Json
          to_date: string
          units?: string
        }
        Update: {
          fetched_at?: string
          from_date?: string
          id?: string
          lat_key?: number
          lon_key?: number
          payload?: Json
          to_date?: string
          units?: string
        }
        Relationships: []
      }
      zones: {
        Row: {
          account_type: Database["public"]["Enums"]["account_type"] | null
          area_max_charge_cents: number | null
          area_min_charge_cents: number
          base_price_cents: number
          boundary: Json | null
          center_latitude: number | null
          center_longitude: number | null
          commercial_base_cents: number | null
          commercial_per_acre_cents: number | null
          commercial_per_station_cents: number | null
          commercial_per_unit_cents: number | null
          created_at: string
          drive_time_minutes: number | null
          geo_match_mode: string
          id: string
          initial_cleanup_cents: number
          latitude: number | null
          longitude: number | null
          name: string
          organization_id: string
          per_dog_addl_cents: number
          postal_prefix: string | null
          price_note: string | null
          price_per_acre_cents: number
          price_per_sqft_cents: number
          pricing_mode: string
          priority: number
          radius_meters: number | null
          zip_codes: string[]
        }
        Insert: {
          account_type?: Database["public"]["Enums"]["account_type"] | null
          area_max_charge_cents?: number | null
          area_min_charge_cents?: number
          base_price_cents?: number
          boundary?: Json | null
          center_latitude?: number | null
          center_longitude?: number | null
          commercial_base_cents?: number | null
          commercial_per_acre_cents?: number | null
          commercial_per_station_cents?: number | null
          commercial_per_unit_cents?: number | null
          created_at?: string
          drive_time_minutes?: number | null
          geo_match_mode?: string
          id?: string
          initial_cleanup_cents?: number
          latitude?: number | null
          longitude?: number | null
          name: string
          organization_id: string
          per_dog_addl_cents?: number
          postal_prefix?: string | null
          price_note?: string | null
          price_per_acre_cents?: number
          price_per_sqft_cents?: number
          pricing_mode?: string
          priority?: number
          radius_meters?: number | null
          zip_codes?: string[]
        }
        Update: {
          account_type?: Database["public"]["Enums"]["account_type"] | null
          area_max_charge_cents?: number | null
          area_min_charge_cents?: number
          base_price_cents?: number
          boundary?: Json | null
          center_latitude?: number | null
          center_longitude?: number | null
          commercial_base_cents?: number | null
          commercial_per_acre_cents?: number | null
          commercial_per_station_cents?: number | null
          commercial_per_unit_cents?: number | null
          created_at?: string
          drive_time_minutes?: number | null
          geo_match_mode?: string
          id?: string
          initial_cleanup_cents?: number
          latitude?: number | null
          longitude?: number | null
          name?: string
          organization_id?: string
          per_dog_addl_cents?: number
          postal_prefix?: string | null
          price_note?: string | null
          price_per_acre_cents?: number
          price_per_sqft_cents?: number
          pricing_mode?: string
          priority?: number
          radius_meters?: number | null
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
      accept_org_invite_for_current_user: {
        Args: { _token?: string }
        Returns: string
      }
      addon_frequency_step: {
        Args: { _f: Database["public"]["Enums"]["addon_frequency"] }
        Returns: string
      }
      admin_generate_addon_charges_through: {
        Args: { _org_id: string; _through: string }
        Returns: number
      }
      admin_generate_invoice_for_client: {
        Args: { _client_id: string; _through: string }
        Returns: string
      }
      admin_generate_seasonal_deepcleans: {
        Args: { _month: number; _org_id: string; _year: number }
        Returns: number
      }
      admin_generate_visits_through: {
        Args: { _org_id: string; _through: string }
        Returns: number
      }
      admin_transition_missed_visits: {
        Args: { _org_id: string }
        Returns: number
      }
      ai_usage_state: {
        Args: { _org_id: string }
        Returns: {
          actions_included: number
          actions_used: number
          hard_cap_actions: number
          over_allowance: boolean
          over_hard_cap: boolean
          overage_cents: number
          overage_cents_per_action: number
          period_month: string
        }[]
      }
      apply_credit_to_invoice: { Args: { _invoice_id: string }; Returns: Json }
      apply_referral_code: {
        Args: { _code: string; _new_client_id: string }
        Returns: Json
      }
      assert_available_on: {
        Args: { _day: string; _staff_id: string }
        Returns: undefined
      }
      assert_runs_routes: { Args: { _staff_id: string }; Returns: undefined }
      assign_billing_tier_for_org: {
        Args: { _org_id: string }
        Returns: string
      }
      assign_demo_visits_to_staff: {
        Args: { _org_id: string }
        Returns: undefined
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
        Args: {
          _display_name?: string
          _org_name: string
          _ref_code?: string
          _timezone?: string
          _utm?: Json
        }
        Returns: string
      }
      bulk_reassign_visits: {
        Args: { _staff_id: string; _visit_ids: string[] }
        Returns: number
      }
      bulk_reschedule_visits: {
        Args: { _to_date: string; _visit_ids: string[] }
        Returns: {
          moved: number
          skipped: number
        }[]
      }
      calendar_feed_events: { Args: { _token_hash: string }; Returns: Json }
      calendar_feed_revoke: { Args: { _scope: string }; Returns: boolean }
      calendar_feed_rotate: {
        Args: { _scope: string; _token_hash: string }
        Returns: string
      }
      calendar_feed_status: {
        Args: never
        Returns: {
          created_at: string
          last_fetched_at: string
          scope: string
        }[]
      }
      can_write_org: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      cast_roadmap_vote: {
        Args: { p_feature: string; p_voter: string }
        Returns: undefined
      }
      change_user_role: {
        Args: {
          _new_role: Database["public"]["Enums"]["app_role"]
          _org_id: string
          _user_id: string
        }
        Returns: undefined
      }
      churn_drivers: {
        Args: { _org_id: string }
        Returns: {
          avg_score: number
          client_count: number
          reason: string
          revenue_at_risk_cents: number
        }[]
      }
      claim_email_campaign_recipients: {
        Args: { _limit: number }
        Returns: {
          campaign_id: string
          client_id: string
          email: string
          organization_id: string
          recipient_id: string
        }[]
      }
      client_cohort_retention: {
        Args: { _months_back?: number; _org_id: string }
        Returns: {
          cohort_month: string
          cohort_size: number
          months_since: number
          retained: number
        }[]
      }
      client_default_billing_cadence: {
        Args: { _client_id: string }
        Returns: string
      }
      client_ltv: {
        Args: { _limit?: number; _org_id: string }
        Returns: {
          active: boolean
          client_id: string
          display_name: string
          monthly_avg_cents: number
          revenue_cents: number
          tenure_days: number
        }[]
      }
      client_may_be_texted: { Args: { _client_id: string }; Returns: boolean }
      client_unsubscribe_token_state: {
        Args: { _token: string }
        Returns: string
      }
      clock_in: { Args: { _at?: string }; Returns: string }
      clock_out: { Args: { _at?: string }; Returns: string | null }
      close_abandoned_impersonation_grants: { Args: never; Returns: number }
      closing_drive_min: {
        Args: {
          _last_visit_id: string
          _org_id: string
          _staff_id: string
          _visit_ids: string[]
        }
        Returns: number
      }
      complete_visit: {
        Args: {
          _checked_items?: string[]
          _completed_at?: string
          _no_photo_reason?: string
          _note?: string
          _visit_id: string
        }
        Returns: undefined
      }
      confirm_open_visit: {
        Args: {
          _completed: boolean
          _completed_at?: string
          _note?: string
          _visit_id: string
        }
        Returns: string
      }
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
      create_franchise_link_code: { Args: never; Returns: string }
      default_skip_billable_pct: {
        Args: { _code: Database["public"]["Enums"]["skip_reason_code"] }
        Returns: number
      }
      delete_email: {
        Args: { message_id: number; queue_name: string }
        Returns: boolean
      }
      delete_my_account: {
        Args: { _close_workspace?: boolean; _transfer_to?: string }
        Returns: Json
      }
      detect_review_items: { Args: { _org_id?: string }; Returns: number }
      drive_minutes: {
        Args: {
          _lat1: number
          _lat2: number
          _lon1: number
          _lon2: number
          _org_id: string
        }
        Returns: number
      }
      dry_day_min: {
        Args: { _org_id: string; _staff_id: string }
        Returns: number
      }
      effective_speed_kmh: {
        Args: { _area_type: string; _traffic: string }
        Returns: number
      }
      email_campaign_stats: {
        Args: { _org_id: string }
        Returns: {
          bounced: number
          campaign_id: string
          failed: number
          in_queue: number
          recipients: number
          sent: number
          skipped: number
          waiting: number
        }[]
      }
      email_has_account: { Args: { _email: string }; Returns: boolean }
      email_queue_depth: { Args: { queue_name: string }; Returns: number }
      enqueue_email: {
        Args: { payload: Json; queue_name: string }
        Returns: number
      }
      file_reversal_review_item: {
        Args: {
          _adjustment_id?: string
          _amount_cents: number
          _authoritative?: boolean
          _dispute_ref?: string
          _kind: string
          _org_id: string
          _payment_id: string
          _revenue_cents?: number
        }
        Returns: string
      }
      finalize_visit_completion: {
        Args: { _visit_id: string }
        Returns: undefined
      }
      franchise_adjustment_ledger: {
        Args: { _org_id: string }
        Returns: {
          amount_cents: number
          child_name: string
          child_organization_id: string
          collected_by_parent: boolean
          created_at: string
          dispute_ref: string
          franchise_share_cents: number
          id: string
          kind: string
          location_share_cents: number
          note: string
          payment_id: string
          repaid_amount_cents: number
          repaid_at: string
          repaid_settlement_id: string
          repaid_settlement_period_end: string
          repaid_settlement_period_start: string
          repaid_settlement_status: string
          repays_adjustment_id: string
          repays_amount_cents: number
          repays_created_at: string
          repays_settlement_period_end: string
          repays_settlement_period_start: string
          reversed_at: string
          reversed_by_adjustment_id: string
          settlement_id: string
          settlement_period_end: string
          settlement_period_start: string
          settlement_status: string
          status: string
        }[]
      }
      franchise_children: {
        Args: { _parent_org: string }
        Returns: {
          id: string
          name: string
        }[]
      }
      franchise_payment_routing: {
        Args: never
        Returns: {
          chargeback_responsibility: string
          child_account_id: string
          child_charges_enabled: boolean
          child_name: string
          child_organization_id: string
          payments_collected_by_parent: boolean
          royalty_percent: number
        }[]
      }
      franchise_rollup: {
        Args: { _parent_org: string }
        Returns: {
          active_clients: number
          ar_open_cents: number
          organization_id: string
          organization_name: string
          refunds_mtd_cents: number
          revenue_mtd_cents: number
          revenue_mtd_gross_cents: number
          tech_count: number
          visits_completed_today: number
          visits_today: number
        }[]
      }
      franchise_signals: {
        Args: never
        Returns: {
          already_linked: number
          email_domain: string
          org_count: number
          orgs: Json
          state_count: number
          states: string
          stripe_accounts: number
        }[]
      }
      generate_addon_charges_through: {
        Args: { _org_id: string; _through: string }
        Returns: number
      }
      generate_franchise_settlements: {
        Args: { _end: string; _parent: string; _start: string }
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
      generate_visits_core: {
        Args: { _org_id: string; _subscription_id?: string; _through: string }
        Returns: number
      }
      generate_visits_for_subscription: {
        Args: { _org_id: string; _subscription_id: string; _through: string }
        Returns: number
      }
      generate_visits_through: {
        Args: { _org_id: string; _through: string }
        Returns: number
      }
      get_my_tenant_referrals: {
        Args: never
        Returns: {
          created_at: string
          eligible_at: string
          flagged: boolean
          id: string
          paid_at: string
          referred_org_name: string
          reward_cents: number
          status: string
        }[]
      }
      get_or_create_org_referral_code: {
        Args: { _org_id: string }
        Returns: string
      }
      has_permission: {
        Args: { _org_id: string; _permission: string; _user_id: string }
        Returns: boolean
      }
      has_plan_entitlement: {
        Args: { _entitlement: string; _org_id: string }
        Returns: boolean
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
      increment_unit_offense: { Args: { _unit_id: string }; Returns: undefined }
      is_org_member: {
        Args: { _org_id: string; _user_id: string }
        Returns: boolean
      }
      is_platform_admin: { Args: { _user_id: string }; Returns: boolean }
      is_staff_off: {
        Args: { _day: string; _staff_id: string }
        Returns: boolean
      }
      is_valid_entity_name: { Args: { _name: string }; Returns: boolean }
      is_valid_label: { Args: { _label: string }; Returns: boolean }
      is_visit_tech: {
        Args: { _user_id: string; _visit_id: string }
        Returns: boolean
      }
      list_org_users: {
        Args: { _org_id: string }
        Returns: {
          active: boolean
          created_at: string
          display_name: string
          email: string
          role: Database["public"]["Enums"]["app_role"]
          staff_id: string
          user_id: string
        }[]
      }
      log_dna_sample_from_field: {
        Args: {
          _location_note?: string
          _sample_kind?: string
          _sample_photo_path?: string
          _unit_id?: string
          _visit_id: string
        }
        Returns: string
      }
      log_station_service: {
        Args: {
          _bags_collected?: number
          _liner_replaced?: boolean
          _notes?: string
          _photo_url?: string
          _refill_bags_added?: number
          _serviced_at?: string
          _visit_id: string
          _waste_station_id: string
        }
        Returns: string
      }
      mark_franchise_parent: { Args: { _org_id: string }; Returns: undefined }
      mark_review_asked: { Args: { _client_id: string }; Returns: boolean }
      may_read_client: { Args: { _client_id: string }; Returns: boolean }
      may_read_property: { Args: { _property_id: string }; Returns: boolean }
      move_to_dlq: {
        Args: {
          dlq_name: string
          message_id: number
          payload: Json
          source_queue: string
        }
        Returns: number
      }
      next_station_number: { Args: { _property_id: string }; Returns: number }
      next_visit_date: {
        Args: {
          _freq: Database["public"]["Enums"]["service_frequency"]
          _from: string
        }
        Returns: string
      }
      office_add_time_entry: {
        Args: {
          _clock_in: string
          _clock_out: string
          _note?: string
          _staff_id: string
        }
        Returns: string
      }
      office_complete_visit: { Args: { _visit_id: string }; Returns: undefined }
      office_edit_time_entry: {
        Args: {
          _clock_in: string
          _clock_out: string | null
          _id: string
          _note?: string
        }
        Returns: string
      }
      office_skip_visit: {
        Args: {
          _code?: Database["public"]["Enums"]["skip_reason_code"]
          _reason: string
          _visit_id: string
        }
        Returns: undefined
      }
      optimize_route_v2: {
        Args: {
          _day: string
          _org_id: string
          _reassign?: boolean
          _staff_id: string
        }
        Returns: number
      }
      optimize_route_v3: {
        Args: {
          _day: string
          _level?: string
          _org_id: string
          _reassign?: boolean
          _staff_id: string
        }
        Returns: number
      }
      optimize_week: {
        Args: { _days?: number; _org_id: string; _start_date: string }
        Returns: {
          assigned: number
          day: string
          staff_id: string
        }[]
      }
      org_accepts_public_leads: { Args: { _org_id: string }; Returns: boolean }
      org_can_add_client: { Args: { _org_id: string }; Returns: boolean }
      org_has_commercial_data: { Args: { _org_id: string }; Returns: boolean }
      org_seat_overage_cents: { Args: { _org_id: string }; Returns: number }
      phone_digits: { Args: { _p: string }; Returns: string }
      plan_day_across_staff: {
        Args: {
          _day: string
          _level?: string
          _org_id: string
          _reassign?: boolean
          _staff_ids: string[]
        }
        Returns: {
          service_min: number
          staff_id: string
          stops: number
          total_min: number
          travel_min: number
        }[]
      }
      plan_day_across_staff_dryrun: {
        Args: {
          _day: string
          _level?: string
          _org_id: string
          _reassign?: boolean
          _staff_ids: string[]
        }
        Returns: {
          eta_end: string
          eta_start: string
          seq: number
          staff_id: string
          travel_km: number
          travel_min: number
          visit_id: string
          window_violated: boolean
        }[]
      }
      plan_route: {
        Args: {
          _day: string
          _level?: string
          _org_id: string
          _reassign?: boolean
          _staff_id: string
        }
        Returns: {
          eta_end: string
          eta_start: string
          seq: number
          travel_km: number
          travel_min: number
          visit_id: string
          window_violated: boolean
        }[]
      }
      plan_tier_for_org: { Args: { _org_id: string }; Returns: string }
      plan_visits: {
        Args: {
          _day: string
          _level?: string
          _org_id: string
          _staff_id: string
          _visit_ids: string[]
        }
        Returns: {
          eta_end: string
          eta_start: string
          seq: number
          travel_km: number
          travel_min: number
          visit_id: string
          window_violated: boolean
        }[]
      }
      portal_cancel_addon: {
        Args: { _addon_subscription_id: string; _token: string }
        Returns: undefined
      }
      portal_change_deadline: {
        Args: {
          _cutoff_hours: number
          _scheduled_on: string
          _timezone: string
        }
        Returns: string
      }
      portal_change_frequency: {
        Args: {
          _new_frequency: Database["public"]["Enums"]["service_frequency"]
          _subscription_id: string
          _token: string
        }
        Returns: string
      }
      portal_get_client: {
        Args: { _token: string }
        Returns: {
          account_type: string
          allow_frequency_change: boolean
          allow_self_reschedule: boolean
          allow_vacation_hold: boolean
          auto_apply_changes: boolean
          autopay_enabled: boolean
          brand_color: string
          card_brand: string
          card_last4: string
          client_id: string
          contact_email: string
          contact_phone: string
          credit_balance_cents: number
          display_name: string
          has_saved_card: boolean
          logo_url: string
          next_visit_eta_end: string
          next_visit_eta_start: string
          next_visit_id: string
          next_visit_on: string
          next_visit_tech_name: string
          org_name: string
          organization_id: string
          primary_billing_cadence: string
          primary_dog_count: number
          primary_frequency: string
          primary_phone: string
          primary_price_cents: number
          primary_unit_count: number
          reschedule_cutoff_hours: number
          sms_consent_at: string
          sms_opt_out: boolean
          station_count: number
        }[]
      }
      portal_get_referral: {
        Args: { _token: string }
        Returns: {
          referral_code: string
        }[]
      }
      portal_list_addon_catalog: {
        Args: { _token: string }
        Returns: {
          addon_service_id: string
          code: string
          default_frequency: Database["public"]["Enums"]["addon_frequency"]
          description: string
          kind: Database["public"]["Enums"]["addon_kind"]
          name: string
          unit_price_cents: number
        }[]
      }
      portal_list_client_addons: {
        Args: { _token: string }
        Returns: {
          addon_service_id: string
          addon_subscription_id: string
          frequency: Database["public"]["Enums"]["addon_frequency"]
          name: string
          next_charge_on: string
          price_cents: number
          property_label: string
          quantity: number
          status: string
        }[]
      }
      portal_list_dogs: {
        Args: { _token: string }
        Returns: {
          breed: string
          dog_id: string
          name: string
          notes: string
          temperament: string
          weight_class: string
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
      portal_list_my_requests: {
        Args: { _token: string }
        Returns: {
          booked_on: string
          category: string
          created_at: string
          message: string
          requested_on: string
          resolution_note: string
          resolved_at: string
          status: string
          ticket_id: string
          visit_date: string
          visit_id: string
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
      portal_list_recent_visits: {
        Args: { _token: string }
        Returns: {
          completed_at: string
          photo_kinds: string[]
          photo_paths: string[]
          scheduled_on: string
          skip_reason: string
          skip_reason_code: string
          status: Database["public"]["Enums"]["visit_status"]
          tech_name: string
          visit_id: string
        }[]
      }
      portal_list_stations: {
        Args: { _token: string }
        Returns: {
          label: string
          last_serviced_on: string
          liner_size: string
          location_description: string
          station_id: string
          station_number: number
        }[]
      }
      portal_list_upcoming_visits: {
        Args: { _token: string }
        Returns: {
          changes_allowed_until: string
          city: string
          eta_end: string
          eta_start: string
          postal_code: string
          scheduled_on: string
          status: Database["public"]["Enums"]["visit_status"]
          street: string
          tech_name: string
          visit_id: string
          weather_flagged: boolean
          weather_note: string
        }[]
      }
      portal_redeem_promo: {
        Args: { _code: string; _token: string }
        Returns: number
      }
      portal_report_concern: {
        Args: {
          _category: string
          _message: string
          _token: string
          _visit_id: string
        }
        Returns: string
      }
      portal_request_one_off: {
        Args: {
          _message: string
          _on: string
          _property_id: string
          _token: string
        }
        Returns: {
          created: boolean
          ticket_id: string
        }[]
      }
      portal_request_reclean: {
        Args: { _message: string; _token: string; _visit_id: string }
        Returns: string
      }
      portal_request_skip: {
        Args: { _reason: string; _token: string; _visit_id: string }
        Returns: undefined
      }
      portal_request_vacation_hold: {
        Args: { _end: string; _reason: string; _start: string; _token: string }
        Returns: number
      }
      portal_reschedule_visit: {
        Args: { _new_date: string; _token: string; _visit_id: string }
        Returns: undefined
      }
      portal_set_autopay: {
        Args: { _enabled: boolean; _token: string }
        Returns: boolean
      }
      portal_start_prepaid_topup: {
        Args: { _subscription_id: string; _token: string; _visit_count: number }
        Returns: string
      }
      portal_subscribe_addon: {
        Args: {
          _addon_service_id: string
          _frequency: Database["public"]["Enums"]["addon_frequency"]
          _property_id?: string
          _quantity: number
          _token: string
        }
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
      preview_optimize: {
        Args: {
          _from: string
          _level?: string
          _org_id: string
          _reassign?: boolean
          _staff_ids: string[]
          _to: string
        }
        Returns: {
          after_min: number
          before_known: boolean
          before_min: number
          day: string
          staff_id: string
          stops: number
          violations: number
        }[]
      }
      provision_franchise_location: {
        Args: { _members?: Json; _name: string }
        Returns: string
      }
      prune_road_legs: {
        Args: { _older_than?: string }
        Returns: {
          orphaned_removed: number
          stale_removed: number
        }[]
      }
      public_get_org_by_slug: {
        Args: { _slug: string }
        Returns: {
          brand_color: string
          currency: string
          id: string
          logo_url: string
          name: string
          public_signup_enabled: boolean
          resolved_slug: string
        }[]
      }
      public_get_org_for_lead_form: {
        Args: { _slug: string }
        Returns: {
          id: string
          name: string
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
      public_quote_document: { Args: { _token: string }; Returns: Json }
      public_quote_respond: {
        Args: { _accept: boolean; _name: string; _reason: string; _token: string }
        Returns: Json
      }
      read_email_batch: {
        Args: { batch_size: number; queue_name: string; vt: number }
        Returns: {
          message: Json
          msg_id: number
          read_ct: number
        }[]
      }
      reassign_all_billing_tiers: { Args: never; Returns: number }
      reassign_visit: {
        Args: { _staff_id: string; _visit_id: string }
        Returns: undefined
      }
      record_client_sms_consent: {
        Args: { _client_id: string; _source: string; _text: string }
        Returns: undefined
      }
      record_franchise_adjustment: {
        Args: {
          _amount_cents: number
          _dispute_ref?: string
          _kind: string
          _note?: string
          _payment_id: string
        }
        Returns: string
      }
      record_visit_station_service: {
        Args: { _visit_id: string }
        Returns: number
      }
      redeem_client_unsubscribe_token: {
        Args: { _token: string }
        Returns: string
      }
      redeem_franchise_link_code: { Args: { _code: string }; Returns: string }
      redeem_gift_card: {
        Args: {
          _amount_cents: number
          _client_id: string
          _code: string
          _invoice_id?: string
          _note?: string
          _org_id: string
        }
        Returns: {
          redeemed_cents: number
          remaining_cents: number
        }[]
      }
      redistribute_staff_work: {
        Args: { _from?: string; _staff_id: string }
        Returns: number
      }
      refresh_active_client_count: {
        Args: { _org_id: string }
        Returns: undefined
      }
      refresh_active_seat_count: {
        Args: { _org_id: string }
        Returns: undefined
      }
      refresh_road_profile: {
        Args: { _org_id: string }
        Returns: {
          legs: number
          road_factor: number
          speed_kmh: number
        }[]
      }
      regenerate_portal_token: { Args: { _client_id: string }; Returns: string }
      renumber_property_stations: {
        Args: { _property_id: string }
        Returns: number
      }
      reorder_route: {
        Args: { _day: string; _ordered_ids: string[]; _staff_id: string }
        Returns: number
      }
      reschedule_visit: {
        Args: { _new_date: string; _note?: string; _visit_id: string }
        Returns: undefined
      }
      resequence_staff_day: {
        Args: {
          _day: string
          _level?: string
          _org_id: string
          _staff_id: string
        }
        Returns: number
      }
      reverse_prepaid_credit_for_payment: {
        Args: { _payment_id: string; _refunded_cents: number }
        Returns: number
      }
      road_km: {
        Args: {
          _lat1: number
          _lat2: number
          _lon1: number
          _lon2: number
          _org_id: string
        }
        Returns: number
      }
      roadmap_vote_counts: {
        Args: never
        Returns: {
          feature: string
          votes: number
        }[]
      }
      routable_staff: {
        Args: { _day: string; _org_id: string; _staff_ids: string[] }
        Returns: string[]
      }
      route_cost_current: {
        Args: { _day: string; _org_id: string; _staff_id: string }
        Returns: {
          minutes: number
          sequenced: boolean
          stops: number
        }[]
      }
      route_segment_km: {
        Args: { _ids: string[]; _start_lat: number; _start_lon: number }
        Returns: number
      }
      route_segment_min: { Args: { _ids: string[] }; Returns: number }
      run_billing_cycles: { Args: { _org_id?: string }; Returns: number }
      seed_demo_org: { Args: { _org_id: string }; Returns: Json }
      set_addon_subscription_status: {
        Args: { _id: string; _status: string }
        Returns: Json
      }
      set_chargeback_responsibility: {
        Args: { _child_org_id: string; _responsibility: string }
        Returns: undefined
      }
      set_child_royalty_percent: {
        Args: { _child_org_id: string; _percent: number }
        Returns: undefined
      }
      set_location_payment_routing: {
        Args: { _child_org_id: string; _collected_by_parent: boolean }
        Returns: undefined
      }
      set_org_commercial_accounts: {
        Args: { _enabled: boolean }
        Returns: Json
      }
      set_staff_active: {
        Args: { _active: boolean; _staff_id: string }
        Returns: undefined
      }
      settle_email_campaigns: { Args: never; Returns: number }
      skip_visit: {
        Args: {
          _code?: Database["public"]["Enums"]["skip_reason_code"]
          _reason: string
          _skipped_at?: string
          _visit_id: string
        }
        Returns: undefined
      }
      slugify: { Args: { _txt: string }; Returns: string }
      sms_consent_coverage: {
        Args: { _org_id: string }
        Returns: {
          consented: number
          opted_out: number
          with_phone: number
        }[]
      }
      staff_day_minutes: {
        Args: { _day: string; _org_id: string; _staff_id: string }
        Returns: number
      }
      staff_end_point: {
        Args: { _org_id: string; _staff_id: string }
        Returns: {
          lat: number
          lon: number
        }[]
      }
      staff_start_point:
        | {
            Args: { _day: string; _org_id: string; _staff_id: string }
            Returns: {
              lat: number
              lon: number
              source: string
            }[]
          }
        | {
            Args: {
              _day: string
              _org_id: string
              _staff_id: string
              _visit_ids: string[]
            }
            Returns: {
              lat: number
              lon: number
              source: string
            }[]
          }
      staff_time_off_impact: {
        Args: { _from: string; _staff_id: string; _to: string }
        Returns: {
          scheduled_on: string
          visits: number
        }[]
      }
      staff_upcoming_load: {
        Args: { _from?: string; _staff_id: string }
        Returns: {
          scheduled_on: string
          visits: number
        }[]
      }
      start_email_campaign: {
        Args: {
          _campaign_id: string
          _org_id: string
          _recipients: Json
          _user_id: string
        }
        Returns: string
      }
      start_visit: {
        Args: { _started_at?: string; _visit_id: string }
        Returns: undefined
      }
      tip_staff_for_invoice: {
        Args: { _invoice_id: string }
        Returns: string | null
      }
      unlink_franchise_child: {
        Args: { _child_org_id: string }
        Returns: undefined
      }
      update_org_deepclean_settings: {
        Args: {
          _charge_cents: number
          _enabled: boolean
          _months: number[]
          _org_id: string
        }
        Returns: undefined
      }
      update_org_dispatch_settings: {
        Args: {
          _auto_generate_days_ahead?: number
          _avg_speed_kmh?: number
          _clear_avg_speed?: boolean
          _max_drive_minutes?: number
          _notify_schedule_horizon?: boolean
          _org_id: string
          _timezone?: string
          _traffic_profile?: string
          _work_days?: number[]
          _workday_end?: string
          _workday_start?: string
        }
        Returns: undefined
      }
      update_org_standard_pricing: {
        Args: {
          _org_id: string
          _std_base_price_cents: number
          _std_per_dog_addl_cents: number
        }
        Returns: undefined
      }
      void_addon_charge: { Args: { _charge_id: string }; Returns: undefined }
      void_invoice: { Args: { _invoice_id: string }; Returns: undefined }
      zone_profitability: {
        Args: { _from: string; _org_id: string; _to: string }
        Returns: {
          avg_revenue_per_visit_cents: number
          completed_count: number
          revenue_cents: number
          visit_count: number
          zone_id: string
          zone_name: string
        }[]
      }
    }
    Enums: {
      account_type: "residential" | "commercial"
      accounting_entity_type: "invoice" | "payment" | "client"
      accounting_provider: "quickbooks" | "xero"
      accounting_sync_direction: "push" | "pull"
      accounting_sync_status: "pending" | "success" | "error"
      addon_audience: "any" | "residential" | "commercial"
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
      app_role:
        | "owner"
        | "office_manager"
        | "dispatcher"
        | "tech"
        | "platform_admin"
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
      org_billing_status:
        | "free"
        | "active"
        | "past_due"
        | "grace"
        | "suspended"
        | "canceled"
        | "trialing"
      org_plan_status: "free" | "active" | "past_due" | "canceled" | "trialing"
      payment_status: "pending" | "succeeded" | "failed" | "refunded"
      service_frequency:
        | "weekly"
        | "biweekly"
        | "twice_weekly"
        | "monthly"
        | "one_time"
        | "every_n_days"
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
        | "missed"
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
      accounting_entity_type: ["invoice", "payment", "client"],
      accounting_provider: ["quickbooks", "xero"],
      accounting_sync_direction: ["push", "pull"],
      accounting_sync_status: ["pending", "success", "error"],
      addon_audience: ["any", "residential", "commercial"],
      addon_charge_status: [
        "pending",
        "invoiced",
        "paid_from_credit",
        "voided",
      ],
      addon_frequency: ["weekly", "biweekly", "monthly", "quarterly", "yearly"],
      addon_kind: ["one_time", "recurring"],
      app_role: [
        "owner",
        "office_manager",
        "dispatcher",
        "tech",
        "platform_admin",
      ],
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
      org_billing_status: [
        "free",
        "active",
        "past_due",
        "grace",
        "suspended",
        "canceled",
        "trialing",
      ],
      org_plan_status: ["free", "active", "past_due", "canceled", "trialing"],
      payment_status: ["pending", "succeeded", "failed", "refunded"],
      service_frequency: [
        "weekly",
        "biweekly",
        "twice_weekly",
        "monthly",
        "one_time",
        "every_n_days",
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
        "missed",
      ],
    },
  },
} as const
