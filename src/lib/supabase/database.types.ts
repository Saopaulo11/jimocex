// Generated from the JimoCex Supabase schema. Do not edit by hand.
//
// Regenerate after any migration:
//   supabase gen types typescript --project-id <project-ref> > src/lib/supabase/database.types.ts
//
// This file is what makes a typo in a column name a compile error instead of a
// runtime surprise in a financial query.

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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      account_tiers: {
        Row: {
          code: string
          created_at: string
          description: string | null
          is_active: boolean
          name: string
          rank: number
          requires_kyc: boolean
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          description?: string | null
          is_active?: boolean
          name: string
          rank: number
          requires_kyc?: boolean
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          description?: string | null
          is_active?: boolean
          name?: string
          rank?: number
          requires_kyc?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      admin_users: {
        Row: {
          created_at: string
          email: string
          id: string
          is_active: boolean
          role: Database["public"]["Enums"]["admin_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          is_active?: boolean
          role?: Database["public"]["Enums"]["admin_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          is_active?: boolean
          role?: Database["public"]["Enums"]["admin_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      asset_networks: {
        Row: {
          address_regex: string | null
          asset_id: string
          contract_address: string | null
          created_at: string
          deposit_enabled: boolean
          display_name: string
          id: string
          network: string
          required_confirmations: number
          updated_at: string
          withdrawal_enabled: boolean
        }
        Insert: {
          address_regex?: string | null
          asset_id: string
          contract_address?: string | null
          created_at?: string
          deposit_enabled?: boolean
          display_name: string
          id?: string
          network: string
          required_confirmations?: number
          updated_at?: string
          withdrawal_enabled?: boolean
        }
        Update: {
          address_regex?: string | null
          asset_id?: string
          contract_address?: string | null
          created_at?: string
          deposit_enabled?: boolean
          display_name?: string
          id?: string
          network?: string
          required_confirmations?: number
          updated_at?: string
          withdrawal_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "asset_networks_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          created_at: string
          decimals: number
          id: string
          is_active: boolean
          metadata: Json
          name: string
          network: string | null
          symbol: string
          type: Database["public"]["Enums"]["asset_type"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          decimals: number
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          network?: string | null
          symbol: string
          type: Database["public"]["Enums"]["asset_type"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          decimals?: number
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          network?: string | null
          symbol?: string
          type?: Database["public"]["Enums"]["asset_type"]
          updated_at?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: Database["public"]["Enums"]["actor_type"]
          admin_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          ip_hash: string | null
          metadata: Json
          request_id: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type?: Database["public"]["Enums"]["actor_type"]
          admin_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_hash?: string | null
          metadata?: Json
          request_id?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: Database["public"]["Enums"]["actor_type"]
          admin_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_hash?: string | null
          metadata?: Json
          request_id?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "admin_users"
            referencedColumns: ["id"]
          },
        ]
      }
      deposits: {
        Row: {
          address: string | null
          amount: number
          asset_id: string
          confirmations: number
          confirmed_at: string | null
          created_at: string
          credited_at: string | null
          id: string
          network: string | null
          provider_reference: string | null
          status: Database["public"]["Enums"]["deposit_status"]
          tx_hash: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          address?: string | null
          amount: number
          asset_id: string
          confirmations?: number
          confirmed_at?: string | null
          created_at?: string
          credited_at?: string | null
          id?: string
          network?: string | null
          provider_reference?: string | null
          status?: Database["public"]["Enums"]["deposit_status"]
          tx_hash?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          address?: string | null
          amount?: number
          asset_id?: string
          confirmations?: number
          confirmed_at?: string | null
          created_at?: string
          credited_at?: string | null
          id?: string
          network?: string | null
          provider_reference?: string | null
          status?: Database["public"]["Enums"]["deposit_status"]
          tx_hash?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "deposits_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      fee_rules: {
        Row: {
          asset_id: string | null
          created_at: string
          fixed_fee: number
          id: string
          is_active: boolean
          max_fee: number | null
          min_fee: number | null
          operation: Database["public"]["Enums"]["fee_operation"]
          percentage: number
          tier_code: string | null
          updated_at: string
        }
        Insert: {
          asset_id?: string | null
          created_at?: string
          fixed_fee?: number
          id?: string
          is_active?: boolean
          max_fee?: number | null
          min_fee?: number | null
          operation: Database["public"]["Enums"]["fee_operation"]
          percentage?: number
          tier_code?: string | null
          updated_at?: string
        }
        Update: {
          asset_id?: string | null
          created_at?: string
          fixed_fee?: number
          id?: string
          is_active?: boolean
          max_fee?: number | null
          min_fee?: number | null
          operation?: Database["public"]["Enums"]["fee_operation"]
          percentage?: number
          tier_code?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fee_rules_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fee_rules_tier_code_fkey"
            columns: ["tier_code"]
            isOneToOne: false
            referencedRelation: "account_tiers"
            referencedColumns: ["code"]
          },
        ]
      }
      idempotency_keys: {
        Row: {
          completed_at: string | null
          created_at: string
          expires_at: string
          id: string
          key: string
          request_hash: string
          response: Json | null
          scope: string
          status_code: number | null
          user_id: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          key: string
          request_hash: string
          response?: Json | null
          scope: string
          status_code?: number | null
          user_id?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          key?: string
          request_hash?: string
          response?: Json | null
          scope?: string
          status_code?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      kyc_verifications: {
        Row: {
          created_at: string
          decided_at: string | null
          expires_at: string | null
          id: string
          provider_kind: Database["public"]["Enums"]["kyc_provider_kind"]
          provider_name: string | null
          provider_session_id: string | null
          rejection_reason: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["kyc_status"]
          submitted_at: string | null
          target_tier_code: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          expires_at?: string | null
          id?: string
          provider_kind?: Database["public"]["Enums"]["kyc_provider_kind"]
          provider_name?: string | null
          provider_session_id?: string | null
          rejection_reason?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["kyc_status"]
          submitted_at?: string | null
          target_tier_code?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          expires_at?: string | null
          id?: string
          provider_kind?: Database["public"]["Enums"]["kyc_provider_kind"]
          provider_name?: string | null
          provider_session_id?: string | null
          rejection_reason?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["kyc_status"]
          submitted_at?: string | null
          target_tier_code?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "kyc_verifications_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "admin_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kyc_verifications_target_tier_code_fkey"
            columns: ["target_tier_code"]
            isOneToOne: false
            referencedRelation: "account_tiers"
            referencedColumns: ["code"]
          },
        ]
      }
      ledger_entries: {
        Row: {
          amount: number
          asset_id: string
          available_delta: number
          created_at: string
          dedup_key: string | null
          entry_type: Database["public"]["Enums"]["ledger_entry_type"]
          id: string
          locked_delta: number
          metadata: Json
          reference_id: string | null
          reference_type: string | null
          user_id: string
        }
        Insert: {
          amount: number
          asset_id: string
          available_delta?: number
          created_at?: string
          dedup_key?: string | null
          entry_type: Database["public"]["Enums"]["ledger_entry_type"]
          id?: string
          locked_delta?: number
          metadata?: Json
          reference_id?: string | null
          reference_type?: string | null
          user_id: string
        }
        Update: {
          amount?: number
          asset_id?: string
          available_delta?: number
          created_at?: string
          dedup_key?: string | null
          entry_type?: Database["public"]["Enums"]["ledger_entry_type"]
          id?: string
          locked_delta?: number
          metadata?: Json
          reference_id?: string | null
          reference_type?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ledger_entries_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      limit_usage: {
        Row: {
          id: string
          occurred_at: string
          operation: Database["public"]["Enums"]["limit_operation"]
          quote_currency: string
          rate_source: string | null
          reference_id: string
          reference_type: string
          usd_equivalent: number
          user_id: string
        }
        Insert: {
          id?: string
          occurred_at?: string
          operation: Database["public"]["Enums"]["limit_operation"]
          quote_currency?: string
          rate_source?: string | null
          reference_id: string
          reference_type: string
          usd_equivalent: number
          user_id: string
        }
        Update: {
          id?: string
          occurred_at?: string
          operation?: Database["public"]["Enums"]["limit_operation"]
          quote_currency?: string
          rate_source?: string | null
          reference_id?: string
          reference_type?: string
          usd_equivalent?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "limit_usage_quote_currency_fkey"
            columns: ["quote_currency"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["symbol"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string
          channel: Database["public"]["Enums"]["notification_channel"]
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          read_at: string | null
          sent_at: string | null
          status: Database["public"]["Enums"]["notification_status"]
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body: string
          channel?: Database["public"]["Enums"]["notification_channel"]
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          read_at?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string
          channel?: Database["public"]["Enums"]["notification_channel"]
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          read_at?: string | null
          sent_at?: string | null
          status?: Database["public"]["Enums"]["notification_status"]
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          country_code: string | null
          created_at: string
          display_name: string | null
          email: string
          id: string
          kyc_status: Database["public"]["Enums"]["kyc_status"]
          status: Database["public"]["Enums"]["account_status"]
          tier_code: string
          updated_at: string
          user_id: string
        }
        Insert: {
          country_code?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          id?: string
          kyc_status?: Database["public"]["Enums"]["kyc_status"]
          status?: Database["public"]["Enums"]["account_status"]
          tier_code?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          country_code?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          kyc_status?: Database["public"]["Enums"]["kyc_status"]
          status?: Database["public"]["Enums"]["account_status"]
          tier_code?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_tier_code_fkey"
            columns: ["tier_code"]
            isOneToOne: false
            referencedRelation: "account_tiers"
            referencedColumns: ["code"]
          },
        ]
      }
      provider_events: {
        Row: {
          error: string | null
          event_id: string
          event_type: string
          id: string
          payload: Json
          payload_hash: string
          processed_at: string | null
          provider: string
          received_at: string
          signature_valid: boolean
          status: Database["public"]["Enums"]["provider_event_status"]
        }
        Insert: {
          error?: string | null
          event_id: string
          event_type: string
          id?: string
          payload: Json
          payload_hash: string
          processed_at?: string | null
          provider: string
          received_at?: string
          signature_valid?: boolean
          status?: Database["public"]["Enums"]["provider_event_status"]
        }
        Update: {
          error?: string | null
          event_id?: string
          event_type?: string
          id?: string
          payload?: Json
          payload_hash?: string
          processed_at?: string | null
          provider?: string
          received_at?: string
          signature_valid?: boolean
          status?: Database["public"]["Enums"]["provider_event_status"]
        }
        Relationships: []
      }
      risk_events: {
        Row: {
          created_at: string
          decision: Database["public"]["Enums"]["risk_decision"]
          details: Json
          id: string
          overridden_by: string | null
          override_reason: string | null
          rule_code: string | null
          score: number | null
          subject_id: string | null
          subject_type: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          decision: Database["public"]["Enums"]["risk_decision"]
          details?: Json
          id?: string
          overridden_by?: string | null
          override_reason?: string | null
          rule_code?: string | null
          score?: number | null
          subject_id?: string | null
          subject_type: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          decision?: Database["public"]["Enums"]["risk_decision"]
          details?: Json
          id?: string
          overridden_by?: string | null
          override_reason?: string | null
          rule_code?: string | null
          score?: number | null
          subject_id?: string | null
          subject_type?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "risk_events_overridden_by_fkey"
            columns: ["overridden_by"]
            isOneToOne: false
            referencedRelation: "admin_users"
            referencedColumns: ["id"]
          },
        ]
      }
      swap_orders: {
        Row: {
          completed_at: string | null
          created_at: string
          failure_reason: string | null
          fee: number
          fee_asset_id: string | null
          from_amount: number
          from_asset_id: string
          id: string
          provider_reference: string | null
          quote_id: string
          rate: number
          settled_at: string | null
          status: Database["public"]["Enums"]["swap_order_status"]
          to_amount: number
          to_asset_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          failure_reason?: string | null
          fee?: number
          fee_asset_id?: string | null
          from_amount: number
          from_asset_id: string
          id?: string
          provider_reference?: string | null
          quote_id: string
          rate: number
          settled_at?: string | null
          status?: Database["public"]["Enums"]["swap_order_status"]
          to_amount: number
          to_asset_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          failure_reason?: string | null
          fee?: number
          fee_asset_id?: string | null
          from_amount?: number
          from_asset_id?: string
          id?: string
          provider_reference?: string | null
          quote_id?: string
          rate?: number
          settled_at?: string | null
          status?: Database["public"]["Enums"]["swap_order_status"]
          to_amount?: number
          to_asset_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "swap_orders_fee_asset_id_fkey"
            columns: ["fee_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "swap_orders_from_asset_id_fkey"
            columns: ["from_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "swap_orders_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: true
            referencedRelation: "swap_quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "swap_orders_to_asset_id_fkey"
            columns: ["to_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      swap_quotes: {
        Row: {
          created_at: string
          expires_at: string
          fee: number
          fee_asset_id: string | null
          from_amount: number
          from_asset_id: string
          id: string
          output_amount: number
          rate: number
          rate_mode: Database["public"]["Enums"]["rate_mode"]
          rate_source: string
          session_id: string | null
          status: Database["public"]["Enums"]["quote_status"]
          to_asset_id: string
          used_at: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          expires_at: string
          fee?: number
          fee_asset_id?: string | null
          from_amount: number
          from_asset_id: string
          id?: string
          output_amount: number
          rate: number
          rate_mode?: Database["public"]["Enums"]["rate_mode"]
          rate_source: string
          session_id?: string | null
          status?: Database["public"]["Enums"]["quote_status"]
          to_asset_id: string
          used_at?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          expires_at?: string
          fee?: number
          fee_asset_id?: string | null
          from_amount?: number
          from_asset_id?: string
          id?: string
          output_amount?: number
          rate?: number
          rate_mode?: Database["public"]["Enums"]["rate_mode"]
          rate_source?: string
          session_id?: string | null
          status?: Database["public"]["Enums"]["quote_status"]
          to_asset_id?: string
          used_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "swap_quotes_fee_asset_id_fkey"
            columns: ["fee_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "swap_quotes_from_asset_id_fkey"
            columns: ["from_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "swap_quotes_to_asset_id_fkey"
            columns: ["to_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      tier_limits: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          max_amount: number | null
          min_amount: number | null
          operation: Database["public"]["Enums"]["limit_operation"]
          quote_currency: string
          tier_code: string
          updated_at: string
          window_kind: Database["public"]["Enums"]["limit_window"]
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          max_amount?: number | null
          min_amount?: number | null
          operation: Database["public"]["Enums"]["limit_operation"]
          quote_currency?: string
          tier_code: string
          updated_at?: string
          window_kind: Database["public"]["Enums"]["limit_window"]
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          max_amount?: number | null
          min_amount?: number | null
          operation?: Database["public"]["Enums"]["limit_operation"]
          quote_currency?: string
          tier_code?: string
          updated_at?: string
          window_kind?: Database["public"]["Enums"]["limit_window"]
        }
        Relationships: [
          {
            foreignKeyName: "tier_limits_quote_currency_fkey"
            columns: ["quote_currency"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["symbol"]
          },
          {
            foreignKeyName: "tier_limits_tier_code_fkey"
            columns: ["tier_code"]
            isOneToOne: false
            referencedRelation: "account_tiers"
            referencedColumns: ["code"]
          },
        ]
      }
      trades: {
        Row: {
          amount: number
          buy_order_id: string | null
          created_at: string
          fee: number
          fee_asset_id: string | null
          id: string
          pair_id: string
          price: number
          provider_trade_id: string | null
          quote_amount: number
          sell_order_id: string | null
          settled_at: string | null
        }
        Insert: {
          amount: number
          buy_order_id?: string | null
          created_at?: string
          fee?: number
          fee_asset_id?: string | null
          id?: string
          pair_id: string
          price: number
          provider_trade_id?: string | null
          quote_amount: number
          sell_order_id?: string | null
          settled_at?: string | null
        }
        Update: {
          amount?: number
          buy_order_id?: string | null
          created_at?: string
          fee?: number
          fee_asset_id?: string | null
          id?: string
          pair_id?: string
          price?: number
          provider_trade_id?: string | null
          quote_amount?: number
          sell_order_id?: string | null
          settled_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trades_buy_order_id_fkey"
            columns: ["buy_order_id"]
            isOneToOne: false
            referencedRelation: "trading_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_fee_asset_id_fkey"
            columns: ["fee_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_pair_id_fkey"
            columns: ["pair_id"]
            isOneToOne: false
            referencedRelation: "trading_pairs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_sell_order_id_fkey"
            columns: ["sell_order_id"]
            isOneToOne: false
            referencedRelation: "trading_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      trading_orders: {
        Row: {
          amount: number
          average_price: number | null
          client_order_id: string | null
          created_at: string
          filled_amount: number
          id: string
          locked_amount: number
          locked_asset_id: string | null
          pair_id: string
          price: number | null
          provider_order_id: string | null
          reject_reason: string | null
          remaining_amount: number | null
          side: Database["public"]["Enums"]["order_side"]
          status: Database["public"]["Enums"]["order_status"]
          type: Database["public"]["Enums"]["order_type"]
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          average_price?: number | null
          client_order_id?: string | null
          created_at?: string
          filled_amount?: number
          id?: string
          locked_amount?: number
          locked_asset_id?: string | null
          pair_id: string
          price?: number | null
          provider_order_id?: string | null
          reject_reason?: string | null
          remaining_amount?: number | null
          side: Database["public"]["Enums"]["order_side"]
          status?: Database["public"]["Enums"]["order_status"]
          type: Database["public"]["Enums"]["order_type"]
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          average_price?: number | null
          client_order_id?: string | null
          created_at?: string
          filled_amount?: number
          id?: string
          locked_amount?: number
          locked_asset_id?: string | null
          pair_id?: string
          price?: number | null
          provider_order_id?: string | null
          reject_reason?: string | null
          remaining_amount?: number | null
          side?: Database["public"]["Enums"]["order_side"]
          status?: Database["public"]["Enums"]["order_status"]
          type?: Database["public"]["Enums"]["order_type"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trading_orders_locked_asset_id_fkey"
            columns: ["locked_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trading_orders_pair_id_fkey"
            columns: ["pair_id"]
            isOneToOne: false
            referencedRelation: "trading_pairs"
            referencedColumns: ["id"]
          },
        ]
      }
      trading_pairs: {
        Row: {
          amount_precision: number
          base_asset_id: string
          created_at: string
          display_order: number
          id: string
          is_active: boolean
          max_order_size: number | null
          min_order_size: number
          pair_type: Database["public"]["Enums"]["pair_type"]
          price_precision: number
          quote_asset_id: string
          swap_enabled: boolean
          symbol: string
          trading_enabled: boolean
          updated_at: string
        }
        Insert: {
          amount_precision?: number
          base_asset_id: string
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          max_order_size?: number | null
          min_order_size?: number
          pair_type: Database["public"]["Enums"]["pair_type"]
          price_precision?: number
          quote_asset_id: string
          swap_enabled?: boolean
          symbol: string
          trading_enabled?: boolean
          updated_at?: string
        }
        Update: {
          amount_precision?: number
          base_asset_id?: string
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          max_order_size?: number | null
          min_order_size?: number
          pair_type?: Database["public"]["Enums"]["pair_type"]
          price_precision?: number
          quote_asset_id?: string
          swap_enabled?: boolean
          symbol?: string
          trading_enabled?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trading_pairs_base_asset_id_fkey"
            columns: ["base_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trading_pairs_quote_asset_id_fkey"
            columns: ["quote_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      wallets: {
        Row: {
          asset_id: string
          available_balance: number
          created_at: string
          id: string
          locked_balance: number
          updated_at: string
          user_id: string
        }
        Insert: {
          asset_id: string
          available_balance?: number
          created_at?: string
          id?: string
          locked_balance?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          asset_id?: string
          available_balance?: number
          created_at?: string
          id?: string
          locked_balance?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wallets_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
        ]
      }
      withdrawals: {
        Row: {
          amount: number
          asset_id: string
          created_at: string
          destination: string
          destination_tag: string | null
          failure_reason: string | null
          fee: number
          hold_released_at: string | null
          id: string
          idempotency_key: string
          net_amount: number | null
          network: string | null
          processed_at: string | null
          provider_reference: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["withdrawal_status"]
          tx_hash: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          amount: number
          asset_id: string
          created_at?: string
          destination: string
          destination_tag?: string | null
          failure_reason?: string | null
          fee?: number
          hold_released_at?: string | null
          id?: string
          idempotency_key: string
          net_amount?: number | null
          network?: string | null
          processed_at?: string | null
          provider_reference?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["withdrawal_status"]
          tx_hash?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          amount?: number
          asset_id?: string
          created_at?: string
          destination?: string
          destination_tag?: string | null
          failure_reason?: string | null
          fee?: number
          hold_released_at?: string | null
          id?: string
          idempotency_key?: string
          net_amount?: number | null
          network?: string | null
          processed_at?: string | null
          provider_reference?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["withdrawal_status"]
          tx_hash?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "withdrawals_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "withdrawals_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "admin_users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_deposit_for_credit: {
        Args: { p_deposit_id: string }
        Returns: boolean
      }
      claim_provider_event: {
        Args: { p_event_row_id: string }
        Returns: boolean
      }
      consume_quote: {
        Args: { p_quote_id: string; p_session_id?: string; p_user_id?: string }
        Returns: {
          created_at: string
          expires_at: string
          fee: string
          fee_asset_id: string
          from_amount: string
          from_asset_id: string
          id: string
          output_amount: string
          rate: string
          rate_mode: Database["public"]["Enums"]["rate_mode"]
          rate_source: string
          session_id: string
          status: Database["public"]["Enums"]["quote_status"]
          to_asset_id: string
          used_at: string
          user_id: string
        }[]
      }
      expire_stale_quotes: { Args: never; Returns: number }
      has_admin_role: {
        Args: { roles: Database["public"]["Enums"]["admin_role"][] }
        Returns: boolean
      }
      is_admin: { Args: never; Returns: boolean }
      ledger_post: {
        Args: {
          p_amount: number
          p_asset_id: string
          p_available_delta: number
          p_dedup_key?: string
          p_entry_type: Database["public"]["Enums"]["ledger_entry_type"]
          p_locked_delta: number
          p_metadata?: Json
          p_reference_id?: string
          p_reference_type?: string
          p_user_id: string
        }
        Returns: string
      }
      limit_usage_total: {
        Args: {
          p_operation: Database["public"]["Enums"]["limit_operation"]
          p_quote_currency: string
          p_since: string
          p_user_id: string
        }
        Returns: string
      }
      mark_trade_settled: { Args: { p_trade_id: string }; Returns: boolean }
      reconcile_wallets: {
        Args: never
        Returns: {
          asset_id: string
          ledger_available: string
          ledger_locked: string
          user_id: string
          wallet_available: string
          wallet_locked: string
        }[]
      }
      release_withdrawal_hold: {
        Args: { p_withdrawal_id: string }
        Returns: boolean
      }
    }
    Enums: {
      account_status:
        | "ACTIVE"
        | "RESTRICTED"
        | "SUSPENDED"
        | "FROZEN"
        | "CLOSED"
      actor_type: "SYSTEM" | "USER" | "ADMIN" | "PROVIDER"
      admin_role:
        | "SUPER_ADMIN"
        | "COMPLIANCE"
        | "OPERATIONS"
        | "SUPPORT"
        | "VIEWER"
      asset_type: "CRYPTO" | "FIAT"
      deposit_status:
        | "DETECTED"
        | "CONFIRMING"
        | "CONFIRMED"
        | "CREDITED"
        | "REJECTED"
      fee_operation:
        | "SWAP"
        | "TRADE"
        | "DEPOSIT"
        | "WITHDRAWAL"
        | "FIAT_DEPOSIT"
        | "FIAT_WITHDRAWAL"
      kyc_provider_kind: "MANUAL" | "EXTERNAL"
      kyc_status:
        | "NOT_STARTED"
        | "PENDING"
        | "IN_REVIEW"
        | "VERIFIED"
        | "REJECTED"
        | "EXPIRED"
      ledger_entry_type:
        | "DEPOSIT"
        | "WITHDRAWAL"
        | "TRADE"
        | "TRADE_FEE"
        | "SWAP"
        | "SWAP_FEE"
        | "FIAT_DEPOSIT"
        | "FIAT_WITHDRAWAL"
        | "HOLD"
        | "RELEASE"
        | "ADJUSTMENT"
      limit_operation:
        | "SWAP"
        | "TRADE"
        | "CRYPTO_DEPOSIT"
        | "CRYPTO_WITHDRAWAL"
        | "FIAT_DEPOSIT"
        | "FIAT_WITHDRAWAL"
      limit_window: "SINGLE" | "DAILY" | "MONTHLY"
      notification_channel: "EMAIL" | "PUSH" | "IN_APP" | "SMS"
      notification_status: "PENDING" | "SENT" | "FAILED" | "READ"
      order_side: "BUY" | "SELL"
      order_status:
        | "PENDING"
        | "OPEN"
        | "PARTIALLY_FILLED"
        | "FILLED"
        | "CANCELLED"
        | "REJECTED"
        | "EXPIRED"
      order_type: "MARKET" | "LIMIT"
      pair_type: "CRYPTO" | "FX" | "CRYPTO_FIAT" | "FIAT_CRYPTO"
      provider_event_status: "RECEIVED" | "PROCESSED" | "FAILED" | "IGNORED"
      quote_status: "ACTIVE" | "EXPIRED" | "USED" | "CANCELLED"
      rate_mode: "FIXED" | "FLOATING"
      risk_decision: "ALLOW" | "REQUIRE_KYC" | "REVIEW" | "BLOCK"
      swap_order_status:
        | "CREATED"
        | "CONFIRMED"
        | "PROCESSING"
        | "COMPLETED"
        | "FAILED"
        | "EXPIRED"
        | "CANCELLED"
      withdrawal_status:
        | "REQUESTED"
        | "PENDING_REVIEW"
        | "APPROVED"
        | "PROCESSING"
        | "COMPLETED"
        | "FAILED"
        | "REJECTED"
        | "HELD"
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
      account_status: ["ACTIVE", "RESTRICTED", "SUSPENDED", "FROZEN", "CLOSED"],
      actor_type: ["SYSTEM", "USER", "ADMIN", "PROVIDER"],
      admin_role: [
        "SUPER_ADMIN",
        "COMPLIANCE",
        "OPERATIONS",
        "SUPPORT",
        "VIEWER",
      ],
      asset_type: ["CRYPTO", "FIAT"],
      deposit_status: [
        "DETECTED",
        "CONFIRMING",
        "CONFIRMED",
        "CREDITED",
        "REJECTED",
      ],
      fee_operation: [
        "SWAP",
        "TRADE",
        "DEPOSIT",
        "WITHDRAWAL",
        "FIAT_DEPOSIT",
        "FIAT_WITHDRAWAL",
      ],
      kyc_provider_kind: ["MANUAL", "EXTERNAL"],
      kyc_status: [
        "NOT_STARTED",
        "PENDING",
        "IN_REVIEW",
        "VERIFIED",
        "REJECTED",
        "EXPIRED",
      ],
      ledger_entry_type: [
        "DEPOSIT",
        "WITHDRAWAL",
        "TRADE",
        "TRADE_FEE",
        "SWAP",
        "SWAP_FEE",
        "FIAT_DEPOSIT",
        "FIAT_WITHDRAWAL",
        "HOLD",
        "RELEASE",
        "ADJUSTMENT",
      ],
      limit_operation: [
        "SWAP",
        "TRADE",
        "CRYPTO_DEPOSIT",
        "CRYPTO_WITHDRAWAL",
        "FIAT_DEPOSIT",
        "FIAT_WITHDRAWAL",
      ],
      limit_window: ["SINGLE", "DAILY", "MONTHLY"],
      notification_channel: ["EMAIL", "PUSH", "IN_APP", "SMS"],
      notification_status: ["PENDING", "SENT", "FAILED", "READ"],
      order_side: ["BUY", "SELL"],
      order_status: [
        "PENDING",
        "OPEN",
        "PARTIALLY_FILLED",
        "FILLED",
        "CANCELLED",
        "REJECTED",
        "EXPIRED",
      ],
      order_type: ["MARKET", "LIMIT"],
      pair_type: ["CRYPTO", "FX", "CRYPTO_FIAT", "FIAT_CRYPTO"],
      provider_event_status: ["RECEIVED", "PROCESSED", "FAILED", "IGNORED"],
      quote_status: ["ACTIVE", "EXPIRED", "USED", "CANCELLED"],
      rate_mode: ["FIXED", "FLOATING"],
      risk_decision: ["ALLOW", "REQUIRE_KYC", "REVIEW", "BLOCK"],
      swap_order_status: [
        "CREATED",
        "CONFIRMED",
        "PROCESSING",
        "COMPLETED",
        "FAILED",
        "EXPIRED",
        "CANCELLED",
      ],
      withdrawal_status: [
        "REQUESTED",
        "PENDING_REVIEW",
        "APPROVED",
        "PROCESSING",
        "COMPLETED",
        "FAILED",
        "REJECTED",
        "HELD",
      ],
    },
  },
} as const
