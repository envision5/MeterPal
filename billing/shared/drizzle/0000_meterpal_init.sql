-- MeterPal baseline schema.
-- Single-file baseline replacing the historical migration ledger.
-- Generated from the post-removal schema; safe to replay on a fresh database.
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS leaf;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "drizzle"."__drizzle_migrations_id_seq" AS integer;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."bridge_audit_log_id_seq" AS bigint;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."config_audit_log_id_seq" AS bigint;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."paypal_catalog_map_id_seq" AS bigint;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."paypal_order_intents_id_seq" AS bigint;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "public"."wallet_ledger_id_seq" AS bigint;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."account" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP,
    "refresh_token_expires_at" TIMESTAMP,
    "scope" TEXT,
    "password" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public"."account" ADD CONSTRAINT "account_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON public.account USING btree (user_id)
--> statement-breakpoint
ALTER TABLE "public"."account" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."actions" (
    "id" TEXT COLLATE "C" NOT NULL,
    "request_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "org_slug" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "customer_id" TEXT,
    "internal_customer_id" TEXT,
    "entity_id" TEXT,
    "internal_entity_id" TEXT,
    "type" TEXT NOT NULL,
    "auth_type" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "properties" JSONB
);
--> statement-breakpoint
ALTER TABLE "public"."actions" ADD CONSTRAINT "actions_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_actions_on_internal_entity_id ON public.actions USING btree (internal_entity_id)
--> statement-breakpoint
ALTER TABLE "public"."actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."agent_rules" (
    "org_id" TEXT NOT NULL,
    "org_slug" TEXT NOT NULL,
    "entity_rules" JSONB NOT NULL,
    "credit_rules" JSONB NOT NULL,
    "notes" TEXT NOT NULL DEFAULT ''::text,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "public"."agent_rules" ADD CONSTRAINT "agent_rules_pkey" PRIMARY KEY (org_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."api_keys" (
    "id" TEXT COLLATE "C" NOT NULL,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "name" TEXT,
    "prefix" TEXT,
    "org_id" TEXT,
    "user_id" TEXT,
    "env" TEXT,
    "hashed_key" TEXT,
    "meta" JSONB,
    "scopes" JSONB
);
--> statement-breakpoint
ALTER TABLE "public"."api_keys" ADD CONSTRAINT "api_keys_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."api_keys" ADD CONSTRAINT "api_keys_hashed_key_key" UNIQUE (hashed_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."auto_topup_limit_states" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "internal_customer_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "feature_id" TEXT NOT NULL,
    "purchase_window_ends_at" NUMERIC NOT NULL,
    "purchase_count" NUMERIC NOT NULL DEFAULT 0,
    "attempt_window_ends_at" NUMERIC NOT NULL,
    "attempt_count" NUMERIC NOT NULL DEFAULT 0,
    "failed_attempt_window_ends_at" NUMERIC NOT NULL,
    "failed_attempt_count" NUMERIC NOT NULL DEFAULT 0,
    "last_attempt_at" NUMERIC,
    "last_failed_attempt_at" NUMERIC,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "consecutive_failure_count" NUMERIC NOT NULL DEFAULT 0,
    "suspended_at" NUMERIC,
    "suspended_reason" TEXT,
    "suspended_payment_method_fingerprint" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."auto_topup_limit_states" ADD CONSTRAINT "auto_topup_limit_states_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS auto_topup_limits_org_env_internal_customer_feature_unique ON public.auto_topup_limit_states USING btree (org_id, env, internal_customer_id, feature_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."bridge_audit_log" (
    "id" BIGINT NOT NULL DEFAULT nextval('bridge_audit_log_id_seq'::regclass),
    "ts" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "customer_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system'::text,
    "litellm_key_hash" TEXT NOT NULL,
    "metadata" JSONB,
    "error" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."bridge_audit_log" ADD CONSTRAINT "bridge_audit_action_check" CHECK (action = ANY (ARRAY['provision'::text, 'update'::text, 'block'::text, 'unblock'::text, 'sync_failure'::text]));
--> statement-breakpoint
ALTER TABLE "public"."bridge_audit_log" ADD CONSTRAINT "bridge_audit_log_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bridge_audit_action_ts ON public.bridge_audit_log USING btree (action, ts)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bridge_audit_customer_ts ON public.bridge_audit_log USING btree (customer_id, ts)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."bridge_rate_limits" (
    "scope" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
ALTER TABLE "public"."bridge_rate_limits" ADD CONSTRAINT "bridge_rate_limits_pkey" PRIMARY KEY (scope, window_start);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."chat_approval_writes" (
    "id" TEXT NOT NULL,
    "approval_id" TEXT NOT NULL,
    "position" NUMERIC NOT NULL,
    "request_id" TEXT,
    "deny_option_id" TEXT,
    "tool_name" TEXT NOT NULL,
    "tool_args" JSONB NOT NULL,
    "preview" JSONB,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "public"."chat_approval_writes" ADD CONSTRAINT "chat_approval_writes_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."chat_approval_writes" ADD CONSTRAINT "chat_approval_writes_approval_position_key" UNIQUE (approval_id, "position");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."chat_approvals" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "message_ts" TEXT,
    "provider_user_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "run_id" TEXT,
    "tool_call_id" TEXT,
    "tool_name" TEXT NOT NULL,
    "tool_args" JSONB NOT NULL,
    "preview" JSONB,
    "status" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "expires_at" NUMERIC NOT NULL,
    "decided_at" NUMERIC,
    "decided_by_provider_user_id" TEXT,
    "harness" TEXT,
    "child_session_ids" TEXT[],
    "approve_option_id" TEXT,
    "deny_option_id" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."chat_approvals" ADD CONSTRAINT "chat_approvals_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."chat_installations" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "workspace_name" TEXT NOT NULL,
    "bot_user_id" TEXT,
    "bot_access_token" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "default_env" TEXT NOT NULL,
    "sandbox_api_key_id" TEXT,
    "sandbox_api_key" TEXT,
    "live_api_key_id" TEXT,
    "live_api_key" TEXT,
    "installed_by_user_id" TEXT,
    "installed_by_provider_user_id" TEXT,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "auth_mode" TEXT,
    "reply_mode" TEXT NOT NULL DEFAULT 'all_messages'::text
);
--> statement-breakpoint
ALTER TABLE "public"."chat_installations" ADD CONSTRAINT "chat_installations_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."chat_installations" ADD CONSTRAINT "chat_installations_org_provider_key" UNIQUE (org_id, provider);
--> statement-breakpoint
ALTER TABLE "public"."chat_installations" ADD CONSTRAINT "chat_installations_provider_workspace_key" UNIQUE (provider, workspace_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."chat_oauth_credentials" (
    "id" TEXT NOT NULL,
    "chat_installation_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "oauth_client_id" TEXT NOT NULL,
    "oauth_consent_id" TEXT,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "access_token_expires_at" NUMERIC NOT NULL,
    "scopes" JSONB NOT NULL,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "user_id" TEXT,
    "refresh_token_expires_at" NUMERIC
);
--> statement-breakpoint
ALTER TABLE "public"."chat_oauth_credentials" ADD CONSTRAINT "chat_oauth_credentials_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."chat_oauth_credentials" ADD CONSTRAINT "chat_oauth_credentials_installation_org_env_user_key" UNIQUE (chat_installation_id, org_id, env, user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."chat_results" (
    "id" TEXT COLLATE "C" NOT NULL,
    "created_at" NUMERIC,
    "data" JSONB NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public"."chat_results" ADD CONSTRAINT "chat_results_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."chat_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."checkouts" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "internal_customer_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "params_version" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending'::text,
    "response" JSONB,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "expires_at" NUMERIC NOT NULL,
    "completed_at" NUMERIC
);
--> statement-breakpoint
ALTER TABLE "public"."checkouts" ADD CONSTRAINT "checkouts_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."config_audit_log" (
    "id" BIGINT NOT NULL DEFAULT nextval('config_audit_log_id_seq'::regclass),
    "ts" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system'::text,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "metadata" JSONB
);
--> statement-breakpoint
ALTER TABLE "public"."config_audit_log" ADD CONSTRAINT "config_audit_log_env_check" CHECK (env = ANY (ARRAY['sandbox'::text, 'live'::text, 'production'::text]));
--> statement-breakpoint
ALTER TABLE "public"."config_audit_log" ADD CONSTRAINT "config_audit_log_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_config_audit_action_ts ON public.config_audit_log USING btree (action, ts)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_config_audit_org_ts ON public.config_audit_log USING btree (org_id, ts)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customer_entitlements" (
    "id" TEXT COLLATE "C" NOT NULL,
    "customer_product_id" TEXT,
    "entitlement_id" TEXT NOT NULL,
    "internal_customer_id" TEXT COLLATE "C" NOT NULL,
    "internal_entity_id" TEXT,
    "internal_feature_id" TEXT NOT NULL,
    "unlimited" BOOLEAN DEFAULT false,
    "balance" NUMERIC NOT NULL DEFAULT 0,
    "created_at" NUMERIC NOT NULL,
    "next_reset_at" NUMERIC,
    "usage_allowed" BOOLEAN DEFAULT false,
    "adjustment" NUMERIC,
    "additional_balance" NUMERIC NOT NULL DEFAULT 0,
    "entities" JSONB,
    "expires_at" NUMERIC,
    "cache_version" INTEGER DEFAULT 0,
    "customer_id" TEXT,
    "feature_id" TEXT,
    "external_id" TEXT,
    "reset_cycle_anchor" NUMERIC,
    "separate_interval" BOOLEAN NOT NULL DEFAULT false,
    "expired" BOOLEAN,
    "reset_by_invoice" BOOLEAN,
    "is_pooled_balance" BOOLEAN NOT NULL DEFAULT false,
    "pooled_balance_id" TEXT,
    "pooled_contribution_id" TEXT,
    "usage_attribution" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "metadata" JSONB,
    "invoice_credit" BOOLEAN NOT NULL DEFAULT false
);
--> statement-breakpoint
ALTER TABLE "public"."customer_entitlements" ADD CONSTRAINT "customer_entitlements_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ce_customer_product_id_c ON public.customer_entitlements USING btree (customer_product_id COLLATE "C")
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ce_internal_feature_id ON public.customer_entitlements USING btree (internal_feature_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_entitlements_entitlement_id ON public.customer_entitlements USING btree (entitlement_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_entitlements_expiring_grants ON public.customer_entitlements USING btree (expires_at) WHERE ((customer_product_id IS NULL) AND (expires_at IS NOT NULL) AND ((metadata ->> 'source'::text) IS NOT NULL))
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_entitlements_internal_customer_id_btree ON public.customer_entitlements USING btree (internal_customer_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_entitlements_internal_entity_id ON public.customer_entitlements USING hash (internal_entity_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_entitlements_internal_feature_id_c ON public.customer_entitlements USING btree (internal_feature_id COLLATE "C")
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_entitlements_loose_customer_expires ON public.customer_entitlements USING btree (internal_customer_id, expires_at) WHERE (customer_product_id IS NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_entitlements_next_reset_not_expired ON public.customer_entitlements USING btree (next_reset_at) WHERE ((expired IS NOT TRUE) AND (next_reset_at IS NOT NULL))
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_entitlements_on_next_reset_at ON public.customer_entitlements USING btree (next_reset_at)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_entitlements_pooled_contribution ON public.customer_entitlements USING btree (pooled_contribution_id) WHERE (pooled_contribution_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_entitlements_product_id ON public.customer_entitlements USING btree (customer_product_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_entitlements_reset_scan ON public.customer_entitlements USING btree (next_reset_at, id) WHERE ((expired IS NOT TRUE) AND (reset_by_invoice IS NOT TRUE) AND (pooled_contribution_id IS NULL) AND (next_reset_at IS NOT NULL))
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customer_exports" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "requested_by_user_id" TEXT,
    "trigger_run_id" TEXT,
    "s3_key" TEXT,
    "row_count" NUMERIC,
    "byte_count" NUMERIC,
    "error_message" TEXT,
    "created_at" NUMERIC NOT NULL,
    "started_at" NUMERIC,
    "completed_at" NUMERIC,
    "kind" TEXT NOT NULL DEFAULT 'customers'::text
);
--> statement-breakpoint
ALTER TABLE "public"."customer_exports" ADD CONSTRAINT "customer_exports_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS customer_exports_active_per_org_env_kind_unique ON public.customer_exports USING btree (org_id, env, kind) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]))
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_exports_org_env_created_at ON public.customer_exports USING btree (org_id, env, created_at DESC)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customer_jwt_families" (
    "internal_id" TEXT NOT NULL,
    "internal_customer_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "refresh_kid" INTEGER NOT NULL DEFAULT 0,
    "indefinite" BOOLEAN NOT NULL DEFAULT false,
    "created_at" NUMERIC NOT NULL,
    "updated_at" NUMERIC NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public"."customer_jwt_families" ADD CONSTRAINT "customer_jwt_families_pkey" PRIMARY KEY (internal_id);
--> statement-breakpoint
ALTER TABLE "public"."customer_jwt_families" ADD CONSTRAINT "customer_jwt_families_internal_customer_id_key" UNIQUE (internal_customer_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customer_licenses" (
    "id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
    "internal_customer_id" TEXT NOT NULL,
    "parent_customer_product_id" TEXT NOT NULL,
    "license_internal_product_id" TEXT NOT NULL,
    "plan_license_id" TEXT,
    "granted" NUMERIC NOT NULL DEFAULT 0,
    "remaining" NUMERIC NOT NULL DEFAULT 0,
    "paid_quantity" NUMERIC NOT NULL DEFAULT 0,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "public"."customer_licenses" ADD CONSTRAINT "customer_licenses_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_licenses_customer ON public.customer_licenses USING btree (internal_customer_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_licenses_link ON public.customer_licenses USING btree (link_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_licenses_plan_license ON public.customer_licenses USING btree (plan_license_id)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS unique_customer_license ON public.customer_licenses USING btree (parent_customer_product_id, license_internal_product_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customer_lsns" (
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "internal_customer_id" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "public"."customer_lsns" ADD CONSTRAINT "customer_lsns_pkey" PRIMARY KEY (org_id, env, customer_id);
--> statement-breakpoint
ALTER TABLE "public"."customer_lsns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customer_prices" (
    "id" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL,
    "price_id" TEXT,
    "options" JSONB,
    "internal_customer_id" TEXT,
    "customer_product_id" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."customer_prices" ADD CONSTRAINT "customer_prices_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cpr_customer_product_id_c ON public.customer_prices USING btree (customer_product_id COLLATE "C")
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_prices_internal_customer_id ON public.customer_prices USING btree (internal_customer_id COLLATE "C") WHERE (internal_customer_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_prices_price_id ON public.customer_prices USING btree (price_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_prices_product_id ON public.customer_prices USING btree (customer_product_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customer_products" (
    "id" TEXT COLLATE "C" NOT NULL,
    "internal_customer_id" TEXT NOT NULL,
    "internal_product_id" TEXT NOT NULL,
    "internal_entity_id" TEXT,
    "created_at" NUMERIC,
    "updated_at" NUMERIC,
    "status" TEXT,
    "canceled" BOOLEAN DEFAULT false,
    "canceled_at" NUMERIC,
    "ended_at" NUMERIC,
    "starts_at" NUMERIC,
    "access_starts_at" NUMERIC,
    "options" JSONB[],
    "product_id" TEXT,
    "free_trial_id" TEXT,
    "trial_ends_at" NUMERIC,
    "billing_cycle_anchor_resets_at" NUMERIC,
    "collection_method" TEXT DEFAULT 'charge_automatically'::text,
    "subscription_ids" TEXT[],
    "scheduled_ids" TEXT[],
    "quantity" NUMERIC DEFAULT 1,
    "is_custom" BOOLEAN NOT NULL DEFAULT false,
    "customer_id" TEXT,
    "entity_id" TEXT,
    "billing_version" TEXT,
    "api_version" NUMERIC,
    "api_semver" TEXT,
    "external_id" TEXT,
    "previous_customer_product_id" TEXT,
    "on_trial_end" TEXT,
    "billing_cycle_anchor" NUMERIC,
    "customer_license_link_id" TEXT,
    "released_at" NUMERIC,
    "metadata_id" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."customer_products" ADD CONSTRAINT "customer_products_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_customer_license ON public.customer_products USING btree (customer_license_link_id) WHERE (customer_license_link_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_customer_status ON public.customer_products USING btree (internal_customer_id, status)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_customer_status_created_at ON public.customer_products USING btree (internal_customer_id, status, created_at DESC)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_ended_at ON public.customer_products USING btree (ended_at) WHERE ((status = ANY (ARRAY['active'::text, 'past_due'::text])) AND (ended_at IS NOT NULL))
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_free_trial_id ON public.customer_products USING btree (free_trial_id) WHERE (free_trial_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_license_seat_order ON public.customer_products USING btree (customer_license_link_id, created_at, id) WHERE (customer_license_link_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_linked_customer ON public.customer_products USING btree (internal_customer_id) WHERE ((cardinality(subscription_ids) > 0) OR (cardinality(scheduled_ids) > 0))
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_metadata_id ON public.customer_products USING btree (metadata_id) WHERE (metadata_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_on_internal_entity_id ON public.customer_products USING btree (internal_entity_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_on_internal_product_id ON public.customer_products USING btree (internal_product_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_product_customer_c ON public.customer_products USING btree (internal_product_id, internal_customer_id COLLATE "C")
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_product_id ON public.customer_products USING btree (product_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_product_status ON public.customer_products USING btree (internal_product_id, status)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_scheduled_ids ON public.customer_products USING gin (scheduled_ids)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_seat_sync ON public.customer_products USING btree (id) WHERE (customer_license_link_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_subscription_ids ON public.customer_products USING gin (subscription_ids)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_trial_ends_at ON public.customer_products USING btree (trial_ends_at) WHERE ((status = ANY (ARRAY['active'::text, 'past_due'::text])) AND (trial_ends_at IS NOT NULL))
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_products_unused_seats ON public.customer_products USING btree (customer_license_link_id, released_at) WHERE ((customer_license_link_id IS NOT NULL) AND (internal_entity_id IS NULL))
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_pool_assignment ON public.customer_products USING btree (customer_license_link_id, internal_entity_id) WHERE ((customer_license_link_id IS NOT NULL) AND (internal_entity_id IS NOT NULL) AND (status = ANY (ARRAY['active'::text, 'past_due'::text])))
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."customers" (
    "internal_id" TEXT COLLATE "C" NOT NULL,
    "org_id" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL,
    "name" TEXT,
    "id" TEXT,
    "email" TEXT,
    "fingerprint" TEXT,
    "metadata" JSONB,
    "env" TEXT NOT NULL,
    "send_email_receipts" BOOLEAN DEFAULT false,
    "auto_topups" JSONB,
    "spend_limits" JSONB,
    "usage_alerts" JSONB,
    "overage_allowed" JSONB,
    "config" JSONB DEFAULT '{}'::jsonb,
    "usage_limits" JSONB,
    "currency" TEXT,
    "litellm_virtual_key" TEXT,
    "paypal_subscription_id" TEXT,
    "paypal_plan_id" TEXT,
    "paypal_payment_status" TEXT,
    "paypal_payer_id" TEXT,
    "paypal_billing_agreement_id" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."customers" ADD CONSTRAINT "customers_pkey" PRIMARY KEY (internal_id);
--> statement-breakpoint
ALTER TABLE "public"."customers" ADD CONSTRAINT "cus_id_constraint" UNIQUE (org_id, id, env);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS customers_email_null_id_unique ON public.customers USING btree (org_id, env, lower(email)) WHERE ((id IS NULL) AND (email IS NOT NULL) AND (email <> ''::text))
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customers_composite ON public.customers USING btree (org_id, env, id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customers_cursor ON public.customers USING btree (org_id, env, created_at DESC, id DESC)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customers_email_trgm ON public.customers USING gin (email gin_trgm_ops) WHERE (email IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customers_id_trgm ON public.customers USING gin (id gin_trgm_ops) WHERE (id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customers_litellm_vkey ON public.customers USING btree (litellm_virtual_key) WHERE (litellm_virtual_key IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customers_name_trgm ON public.customers USING gin (name gin_trgm_ops) WHERE (name IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customers_org_env_fingerprint ON public.customers USING btree (org_id, env, fingerprint) WHERE (fingerprint IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customers_org_env_internal_id ON public.customers USING btree (org_id, env, internal_id DESC)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customers_org_id_env_created_at ON public.customers USING btree (org_id, env, created_at DESC)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customers_paypal_payer_id ON public.customers USING btree (org_id, env, paypal_payer_id) WHERE (paypal_payer_id IS NOT NULL)
--> statement-breakpoint
ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."entities" (
    "id" TEXT,
    "org_id" TEXT,
    "created_at" NUMERIC NOT NULL,
    "internal_id" TEXT NOT NULL,
    "internal_customer_id" TEXT NOT NULL,
    "env" TEXT,
    "name" TEXT,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "internal_feature_id" TEXT,
    "spend_limits" JSONB,
    "usage_alerts" JSONB,
    "overage_allowed" JSONB,
    "feature_id" TEXT,
    "usage_limits" JSONB
);
--> statement-breakpoint
ALTER TABLE "public"."entities" ADD CONSTRAINT "entities_pkey" PRIMARY KEY (internal_id);
--> statement-breakpoint
ALTER TABLE "public"."entities" ADD CONSTRAINT "entity_id_constraint" UNIQUE (org_id, env, internal_customer_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entities_cursor ON public.entities USING btree (org_id, env, created_at DESC, id DESC)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entities_customer_created_at ON public.entities USING btree (internal_customer_id, created_at DESC, id DESC)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entities_customer_internal_desc ON public.entities USING btree (internal_customer_id, internal_id DESC)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entities_internal_customer_id ON public.entities USING btree (internal_customer_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entities_internal_feature_id ON public.entities USING btree (internal_feature_id) WHERE (internal_feature_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entities_internal_feature_id_c ON public.entities USING btree (internal_feature_id COLLATE "C") WHERE (internal_feature_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entities_org_env_id ON public.entities USING btree (org_id, env, id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."entitlements" (
    "id" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL,
    "internal_feature_id" TEXT NOT NULL,
    "internal_product_id" TEXT,
    "internal_reward_id" TEXT,
    "is_custom" BOOLEAN DEFAULT false,
    "allowance_type" TEXT,
    "allowance" NUMERIC,
    "interval" TEXT,
    "interval_count" NUMERIC DEFAULT 1,
    "carry_from_previous" BOOLEAN DEFAULT false,
    "entity_feature_id" TEXT,
    "org_id" TEXT,
    "feature_id" TEXT,
    "usage_limit" NUMERIC,
    "expiry_duration" TEXT,
    "expiry_length" NUMERIC,
    "rollover" JSONB,
    "pooled" BOOLEAN NOT NULL DEFAULT false,
    "feature_override" JSONB
);
--> statement-breakpoint
ALTER TABLE "public"."entitlements" ADD CONSTRAINT "entitlements_id_key" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entitlements_entity_feature_id ON public.entitlements USING btree (entity_feature_id) WHERE (entity_feature_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entitlements_internal_feature_id ON public.entitlements USING btree (internal_feature_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entitlements_internal_feature_id_c ON public.entitlements USING btree (internal_feature_id COLLATE "C")
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entitlements_internal_product_id ON public.entitlements USING btree (internal_product_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entitlements_internal_reward_id ON public.entitlements USING btree (internal_reward_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entitlements_internal_reward_id_c_partial ON public.entitlements USING btree (internal_reward_id COLLATE "C") WHERE (internal_reward_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_entitlements_reward_feature ON public.entitlements USING btree (internal_reward_id, internal_feature_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."events" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "org_slug" TEXT NOT NULL,
    "internal_customer_id" TEXT,
    "env" TEXT NOT NULL,
    "created_at" BIGINT,
    "timestamp" TIMESTAMPTZ,
    "event_name" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "value" NUMERIC,
    "set_usage" BOOLEAN DEFAULT false,
    "entity_id" TEXT,
    "internal_entity_id" TEXT,
    "internal_product_id" TEXT,
    "customer_id" TEXT NOT NULL,
    "properties" JSONB,
    "deductions" JSONB
);
--> statement-breakpoint
ALTER TABLE "public"."events" ADD CONSTRAINT "events_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."events" ADD CONSTRAINT "unique_event_constraint" UNIQUE (org_id, env, customer_id, event_name, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_events_customer_non_usage_ts ON public.events USING btree (internal_customer_id, "timestamp" DESC, id DESC) WHERE (set_usage = false)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_events_internal_customer_id ON public.events USING btree (internal_customer_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_events_internal_entity_id ON public.events USING btree (internal_entity_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON public.events USING btree ("timestamp")
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."features" (
    "internal_id" TEXT COLLATE "C" NOT NULL,
    "org_id" TEXT NOT NULL,
    "created_at" NUMERIC,
    "env" TEXT,
    "id" TEXT NOT NULL,
    "name" TEXT,
    "type" TEXT NOT NULL,
    "config" JSONB,
    "display" JSONB,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "event_names" TEXT[] DEFAULT '{}'::text[],
    "model_markups" JSONB
);
--> statement-breakpoint
ALTER TABLE "public"."features" ADD CONSTRAINT "features_pkey" PRIMARY KEY (internal_id);
--> statement-breakpoint
ALTER TABLE "public"."features" ADD CONSTRAINT "feature_id_constraint" UNIQUE (org_id, id, env);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_features_composite ON public.features USING btree (org_id, env)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."free_trials" (
    "id" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL,
    "internal_product_id" TEXT,
    "duration" TEXT DEFAULT 'day'::text,
    "length" NUMERIC,
    "unique_fingerprint" BOOLEAN,
    "is_custom" BOOLEAN DEFAULT false,
    "card_required" BOOLEAN DEFAULT false,
    "on_end" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."free_trials" ADD CONSTRAINT "free_trials_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_free_trials_internal_product_id ON public.free_trials USING btree (internal_product_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."invitation" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending'::text,
    "created_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "inviter_id" TEXT NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public"."invitation" ADD CONSTRAINT "invitation_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS invitation_email_idx ON public.invitation USING btree (email)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitation_organizationId_idx" ON public.invitation USING btree (organization_id)
--> statement-breakpoint
ALTER TABLE "public"."invitation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."invoice_line_items" (
    "id" TEXT COLLATE "C" NOT NULL,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "invoice_id" TEXT,
    "processor_id" TEXT,
    "amount" NUMERIC NOT NULL,
    "amount_after_discounts" NUMERIC NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd'::text,
    "raw_quantity" NUMERIC,
    "total_quantity" NUMERIC,
    "paid_quantity" NUMERIC,
    "description" TEXT NOT NULL,
    "description_source" TEXT,
    "direction" TEXT NOT NULL,
    "billing_timing" TEXT,
    "prorated" BOOLEAN NOT NULL DEFAULT false,
    "price_id" TEXT,
    "customer_product_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "customer_price_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "customer_entitlement_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "internal_product_id" TEXT,
    "product_id" TEXT,
    "internal_feature_id" TEXT,
    "feature_id" TEXT,
    "effective_period_start" NUMERIC,
    "effective_period_end" NUMERIC,
    "discounts" JSONB[] DEFAULT '{}'::jsonb[],
    "entities" JSONB NOT NULL DEFAULT '[]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "public"."invoice_line_items" ADD CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."invoice_line_items" ADD CONSTRAINT "invoice_line_items_processor_id_unique" UNIQUE (processor_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_customer_product_ids ON public.invoice_line_items USING gin (customer_product_ids)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice_id ON public.invoice_line_items USING btree (invoice_id) WHERE (invoice_id IS NOT NULL)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."invoice_templates" (
    "internal_id" TEXT NOT NULL,
    "id" TEXT,
    "org_id" TEXT NOT NULL,
    "created_at" NUMERIC,
    "name" TEXT NOT NULL,
    "footer" TEXT,
    "memo" TEXT,
    "net_terms_days" INTEGER
);
--> statement-breakpoint
ALTER TABLE "public"."invoice_templates" ADD CONSTRAINT "invoice_templates_pkey" PRIMARY KEY (internal_id);
--> statement-breakpoint
ALTER TABLE "public"."invoice_templates" ADD CONSTRAINT "invoice_templates_id_unique" UNIQUE (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_invoice_templates_org_id ON public.invoice_templates USING btree (org_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."invoices" (
    "id" TEXT COLLATE "C" NOT NULL,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "product_ids" TEXT[] DEFAULT '{}'::text[],
    "internal_product_ids" TEXT[] DEFAULT '{}'::text[],
    "internal_customer_id" TEXT NOT NULL,
    "internal_entity_id" TEXT,
    "processor_invoice_id" TEXT NOT NULL,
    "processor_type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft'::text,
    "hosted_invoice_url" TEXT,
    "total" NUMERIC NOT NULL DEFAULT 0,
    "amount_paid" NUMERIC,
    "refunded_amount" NUMERIC NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd'::text,
    "discounts" JSONB[] DEFAULT '{}'::jsonb[],
    "items" JSONB[] DEFAULT '{}'::jsonb[]
);
--> statement-breakpoint
ALTER TABLE "public"."invoices" ADD CONSTRAINT "invoices_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."invoices" ADD CONSTRAINT "invoices_processor_invoice_id_key" UNIQUE (processor_invoice_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_invoices_customer_created ON public.invoices USING btree (internal_customer_id, created_at DESC, id DESC)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_invoices_internal_entity_id ON public.invoices USING btree (internal_entity_id) WHERE (internal_entity_id IS NOT NULL)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."jwks" (
    "id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "private_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ
);
--> statement-breakpoint
ALTER TABLE "public"."jwks" ADD CONSTRAINT "jwks_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."jwks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."license_entitlements" (
    "id" TEXT NOT NULL,
    "plan_license_id" TEXT NOT NULL,
    "entitlement_id" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "public"."license_entitlements" ADD CONSTRAINT "license_entitlements_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_license_entitlements_entitlement ON public.license_entitlements USING btree (entitlement_id)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS unique_license_entitlement ON public.license_entitlements USING btree (plan_license_id, entitlement_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."license_prices" (
    "id" TEXT NOT NULL,
    "plan_license_id" TEXT NOT NULL,
    "price_id" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "public"."license_prices" ADD CONSTRAINT "license_prices_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_license_prices_price ON public.license_prices USING btree (price_id)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS unique_license_price ON public.license_prices USING btree (plan_license_id, price_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."member" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member'::text,
    "created_at" TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public"."member" ADD CONSTRAINT "member_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_organizationId_idx" ON public.member USING btree (organization_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_userId_idx" ON public.member USING btree (user_id)
--> statement-breakpoint
ALTER TABLE "public"."member" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."metadata" (
    "id" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "expires_at" NUMERIC,
    "data" JSONB,
    "type" TEXT,
    "processor_invoice_id" TEXT,
    "processor_checkout_session_id" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."metadata" ADD CONSTRAINT "metadata_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_metadata_on_type_expires_at ON public.metadata USING btree (type, expires_at)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS metadata_expires_at_idx ON public.metadata USING btree (expires_at) WHERE (expires_at IS NOT NULL)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."migration_errors" (
    "internal_customer_id" TEXT NOT NULL,
    "migration_job_id" TEXT NOT NULL,
    "created_at" NUMERIC,
    "updated_at" NUMERIC,
    "data" JSONB,
    "message" TEXT,
    "code" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."migration_errors" ADD CONSTRAINT "migration_errors_pkey" PRIMARY KEY (internal_customer_id, migration_job_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."migration_item_runs" (
    "migration_item_run_id" TEXT NOT NULL,
    "migration_internal_id" TEXT NOT NULL,
    "migration_run_id" TEXT,
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "item_kind" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "created_at" NUMERIC NOT NULL,
    "updated_at" NUMERIC,
    "skip_reason" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."migration_item_runs" ADD CONSTRAINT "migration_item_runs_pkey" PRIMARY KEY (migration_item_run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS migration_item_runs_customer_recent_idx ON public.migration_item_runs USING btree (item_id, updated_at DESC) WHERE (item_kind = 'customer'::text)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS migration_item_runs_dry_run_unique ON public.migration_item_runs USING btree (migration_internal_id, migration_run_id, item_kind, item_id) WHERE (dry_run = true)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS migration_item_runs_live_c_idx ON public.migration_item_runs USING btree (migration_internal_id, item_kind, item_id COLLATE "C") WHERE (dry_run = false)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS migration_item_runs_live_item_exclusive ON public.migration_item_runs USING btree (item_kind, item_id COLLATE "C") WHERE ((status = 'running'::text) AND (dry_run = false))
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS migration_item_runs_live_unique ON public.migration_item_runs USING btree (migration_internal_id, item_kind, item_id) WHERE (dry_run = false)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."migration_jobs" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL,
    "updated_at" NUMERIC,
    "current_step" TEXT,
    "from_internal_product_id" TEXT,
    "to_internal_product_id" TEXT,
    "step_details" JSONB
);
--> statement-breakpoint
ALTER TABLE "public"."migration_jobs" ADD CONSTRAINT "migration_jobs_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."migration_runs" (
    "internal_id" TEXT NOT NULL,
    "migration_internal_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "dry_run" BOOLEAN NOT NULL,
    "lazy_run" BOOLEAN NOT NULL DEFAULT false,
    "trigger_run_id" TEXT,
    "error_message" TEXT,
    "only_ids" TEXT[],
    "created_at" NUMERIC NOT NULL,
    "updated_at" NUMERIC,
    "started_at" NUMERIC,
    "finished_at" NUMERIC,
    "target_limit" NUMERIC
);
--> statement-breakpoint
ALTER TABLE "public"."migration_runs" ADD CONSTRAINT "migration_runs_pkey" PRIMARY KEY (internal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS migration_runs_active_org_idx ON public.migration_runs USING btree (org_id, env) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]))
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS migration_runs_active_per_migration_unique ON public.migration_runs USING btree (migration_internal_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]))
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS migration_runs_migration_internal_id_idx ON public.migration_runs USING btree (migration_internal_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."migrations" (
    "internal_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "filter" JSONB,
    "operations" JSONB,
    "prepared_state" JSONB,
    "no_billing_changes" BOOLEAN,
    "retry_failed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" NUMERIC NOT NULL,
    "updated_at" NUMERIC,
    "archived" BOOLEAN NOT NULL DEFAULT false
);
--> statement-breakpoint
ALTER TABLE "public"."migrations" ADD CONSTRAINT "migrations_pkey" PRIMARY KEY (internal_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS migrations_org_env_id_unique ON public.migrations USING btree (org_id, env, id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."oauth_access_token" (
    "id" TEXT NOT NULL,
    "token" TEXT,
    "client_id" TEXT NOT NULL,
    "session_id" TEXT,
    "user_id" TEXT,
    "reference_id" TEXT,
    "refresh_id" TEXT,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ,
    "scopes" TEXT[] NOT NULL,
    "oauth_consent_id" TEXT,
    "resource" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_token_unique" UNIQUE (token);
--> statement-breakpoint
ALTER TABLE "public"."oauth_access_token" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."oauth_client" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT,
    "disabled" BOOLEAN DEFAULT false,
    "skip_consent" BOOLEAN,
    "enable_end_session" BOOLEAN,
    "scopes" TEXT[],
    "user_id" TEXT,
    "created_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ,
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" TEXT[],
    "tos" TEXT,
    "policy" TEXT,
    "software_id" TEXT,
    "software_version" TEXT,
    "software_statement" TEXT,
    "redirect_uris" TEXT[] NOT NULL,
    "post_logout_redirect_uris" TEXT[],
    "token_endpoint_auth_method" TEXT,
    "grant_types" TEXT[],
    "response_types" TEXT[],
    "public" BOOLEAN,
    "type" TEXT,
    "reference_id" TEXT,
    "metadata" JSONB
);
--> statement-breakpoint
ALTER TABLE "public"."oauth_client" ADD CONSTRAINT "oauth_client_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."oauth_client" ADD CONSTRAINT "oauth_client_client_id_unique" UNIQUE (client_id);
--> statement-breakpoint
ALTER TABLE "public"."oauth_client" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."oauth_consent" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT,
    "reference_id" TEXT,
    "scopes" TEXT[] NOT NULL,
    "created_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ,
    "env" TEXT,
    "redirect_uri" TEXT,
    "oauth_api_key_id" TEXT,
    "metadata" JSONB DEFAULT '{}'::jsonb
);
--> statement-breakpoint
ALTER TABLE "public"."oauth_consent" ADD CONSTRAINT "oauth_consent_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."oauth_consent" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."oauth_refresh_token" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "session_id" TEXT,
    "user_id" TEXT NOT NULL,
    "reference_id" TEXT,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ,
    "revoked" TIMESTAMPTZ,
    "scopes" TEXT[] NOT NULL,
    "auth_time" TIMESTAMPTZ,
    "oauth_consent_id" TEXT,
    "resource" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."oauth_refresh_token" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL,
    "metadata" TEXT,
    "default_currency" TEXT DEFAULT 'usd'::text,
    "test_pkey" TEXT,
    "live_pkey" TEXT,
    "svix_config" JSONB DEFAULT '{}'::jsonb,
    "created_at" NUMERIC,
    "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_by" TEXT,
    "onboarded" BOOLEAN DEFAULT false,
    "deployed" BOOLEAN DEFAULT false,
    "redis_config" JSONB,
    "custom_buttons" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "is_sandbox" BOOLEAN NOT NULL DEFAULT false,
    "sandbox_color" TEXT,
    "sandbox_icon" TEXT,
    "idempotency_config" JSONB,
    "claim_state" TEXT,
    "claim_token_hash" TEXT,
    "claim_expires_at" TIMESTAMPTZ,
    "provisioning_source" TEXT,
    "paypal_connected" BOOLEAN DEFAULT false,
    "paypal_config" JSONB
);
--> statement-breakpoint
ALTER TABLE "public"."organizations" ADD CONSTRAINT "organizations_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."organizations" ADD CONSTRAINT "organizations_claim_token_hash_key" UNIQUE (claim_token_hash);
--> statement-breakpoint
ALTER TABLE "public"."organizations" ADD CONSTRAINT "organizations_live_pkey_key" UNIQUE (live_pkey);
--> statement-breakpoint
ALTER TABLE "public"."organizations" ADD CONSTRAINT "organizations_slug_unique" UNIQUE (slug);
--> statement-breakpoint
ALTER TABLE "public"."organizations" ADD CONSTRAINT "organizations_test_pkey_key" UNIQUE (test_pkey);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_organizations_created_at_id ON public.organizations USING btree ("createdAt" DESC, id DESC)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_organizations_name_trgm ON public.organizations USING gin (name gin_trgm_ops) WHERE (name IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_organizations_pending_claim_expiry ON public.organizations USING btree (claim_expires_at) WHERE (claim_state = 'pending'::text)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_organizations_slug_trgm ON public.organizations USING gin (slug gin_trgm_ops) WHERE (slug IS NOT NULL)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."passkey" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "public_key" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "counter" INTEGER NOT NULL,
    "device_type" TEXT NOT NULL,
    "backed_up" BOOLEAN NOT NULL,
    "transports" TEXT,
    "created_at" TIMESTAMPTZ,
    "aaguid" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."passkey" ADD CONSTRAINT "passkey_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."passkey" ADD CONSTRAINT "passkey_credential_id_unique" UNIQUE (credential_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_credentialId_idx" ON public.passkey USING btree (credential_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_userId_idx" ON public.passkey USING btree (user_id)
--> statement-breakpoint
ALTER TABLE "public"."passkey" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."paypal_catalog_map" (
    "id" BIGINT NOT NULL DEFAULT nextval('paypal_catalog_map_id_seq'::regclass),
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "paypal_product_id" TEXT,
    "paypal_plan_id" TEXT,
    "name" TEXT,
    "interval" TEXT,
    "amount_usd" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "public"."paypal_catalog_map" ADD CONSTRAINT "paypal_catalog_map_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_paypal_catalog_map_plan_id ON public.paypal_catalog_map USING btree (paypal_plan_id)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_paypal_catalog_map_unique ON public.paypal_catalog_map USING btree (org_id, env, product_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."paypal_order_intents" (
    "id" BIGINT NOT NULL DEFAULT nextval('paypal_order_intents_id_seq'::regclass),
    "order_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "amount_usd" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending'::text,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "subscription_id" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."paypal_order_intents" ADD CONSTRAINT "paypal_order_intents_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."paypal_order_intents" ADD CONSTRAINT "paypal_order_intents_order_id_unique" UNIQUE (order_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_paypal_order_intents_customer ON public.paypal_order_intents USING btree (customer_id, status)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."phases" (
    "id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "starts_at" NUMERIC NOT NULL,
    "customer_product_ids" TEXT[] NOT NULL DEFAULT '{}'::text[],
    "created_at" NUMERIC NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public"."phases" ADD CONSTRAINT "phases_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."phases" ADD CONSTRAINT "phases_schedule_id_starts_at_key" UNIQUE (schedule_id, starts_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."plan_license" (
    "id" TEXT NOT NULL,
    "parent_internal_product_id" TEXT NOT NULL,
    "license_internal_product_id" TEXT NOT NULL,
    "is_custom" BOOLEAN NOT NULL DEFAULT false,
    "included" INTEGER NOT NULL DEFAULT 0,
    "prepaid_only" BOOLEAN NOT NULL DEFAULT true,
    "customized" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB DEFAULT '{}'::jsonb,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "public"."plan_license" ADD CONSTRAINT "plan_license_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_plan_license_license ON public.plan_license USING btree (license_internal_product_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_plan_license_parent_product ON public.plan_license USING btree (parent_internal_product_id)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS unique_plan_license ON public.plan_license USING btree (parent_internal_product_id, license_internal_product_id) WHERE (is_custom = false)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."pooled_balance_contributions" (
    "id" TEXT NOT NULL,
    "pooled_balance_id" TEXT NOT NULL,
    "source_customer_product_id" TEXT NOT NULL,
    "source_customer_entitlement_id" TEXT NOT NULL,
    "current_contribution" NUMERIC NOT NULL DEFAULT 0,
    "next_cycle_contribution" NUMERIC NOT NULL DEFAULT 0,
    "effective_at" NUMERIC,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "public"."pooled_balance_contributions" ADD CONSTRAINT "pooled_balance_contributions_current_non_negative" CHECK (current_contribution >= 0::numeric);
--> statement-breakpoint
ALTER TABLE "public"."pooled_balance_contributions" ADD CONSTRAINT "pooled_balance_contributions_next_non_negative" CHECK (next_cycle_contribution >= 0::numeric);
--> statement-breakpoint
ALTER TABLE "public"."pooled_balance_contributions" ADD CONSTRAINT "pooled_balance_contributions_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."pooled_balance_contributions" ADD CONSTRAINT "unique_pooled_balance_contribution" UNIQUE (source_customer_entitlement_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pooled_balance_contributions_pool ON public.pooled_balance_contributions USING btree (pooled_balance_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pooled_balance_contributions_source_customer_entitlement ON public.pooled_balance_contributions USING btree (source_customer_entitlement_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."pooled_balances" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "internal_customer_id" TEXT NOT NULL,
    "internal_feature_id" TEXT NOT NULL,
    "granted" NUMERIC NOT NULL DEFAULT 0,
    "interval" TEXT NOT NULL,
    "interval_count" NUMERIC NOT NULL DEFAULT 1,
    "reset_cycle_anchor" NUMERIC,
    "reset_mode" TEXT NOT NULL,
    "processor_subscription_id" TEXT,
    "customer_license_link_id" TEXT,
    "rollover_signature" TEXT NOT NULL DEFAULT 'none'::text,
    "customer_entitlement_id" TEXT NOT NULL,
    "last_applied_reset_at" NUMERIC,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "expires_at" NUMERIC,
    "unlimited" BOOLEAN NOT NULL DEFAULT false
);
--> statement-breakpoint
ALTER TABLE "public"."pooled_balances" ADD CONSTRAINT "pooled_balances_granted_non_negative" CHECK (granted >= 0::numeric);
--> statement-breakpoint
ALTER TABLE "public"."pooled_balances" ADD CONSTRAINT "pooled_balances_interval_count_positive" CHECK (interval_count > 0::numeric);
--> statement-breakpoint
ALTER TABLE "public"."pooled_balances" ADD CONSTRAINT "pooled_balances_reset_mode_valid" CHECK (reset_mode = ANY (ARRAY['lazy'::text, 'subscription'::text, 'lifetime'::text]));
--> statement-breakpoint
ALTER TABLE "public"."pooled_balances" ADD CONSTRAINT "pooled_balances_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."pooled_balances" ADD CONSTRAINT "unique_pooled_balance" UNIQUE NULLS NOT DISTINCT (internal_customer_id, internal_feature_id, unlimited, "interval", interval_count, reset_cycle_anchor, reset_mode, processor_subscription_id, customer_license_link_id, rollover_signature, expires_at);
--> statement-breakpoint
ALTER TABLE "public"."pooled_balances" ADD CONSTRAINT "unique_pooled_balance_customer_entitlement" UNIQUE (customer_entitlement_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pooled_balances_customer_license ON public.pooled_balances USING btree (internal_customer_id, customer_license_link_id) WHERE (customer_license_link_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pooled_balances_feature ON public.pooled_balances USING btree (internal_feature_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pooled_balances_org ON public.pooled_balances USING btree (org_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pooled_balances_processor_subscription ON public.pooled_balances USING btree (internal_customer_id, processor_subscription_id) WHERE (processor_subscription_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pooled_balances_reset_mode ON public.pooled_balances USING btree (internal_customer_id, reset_mode)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."prices" (
    "id" TEXT COLLATE "C" NOT NULL,
    "org_id" TEXT NOT NULL,
    "internal_product_id" TEXT NOT NULL,
    "config" JSONB,
    "created_at" NUMERIC NOT NULL,
    "billing_type" TEXT,
    "tier_behavior" TEXT,
    "is_custom" BOOLEAN DEFAULT false,
    "entitlement_id" TEXT,
    "proration_config" JSONB
);
--> statement-breakpoint
ALTER TABLE "public"."prices" ADD CONSTRAINT "prices_id_key" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_prices_config_internal_feature_id ON public.prices USING btree (((config ->> 'internal_feature_id'::text))) WHERE ((config ->> 'internal_feature_id'::text) IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_prices_entitlement_id ON public.prices USING btree (entitlement_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_prices_internal_product_id ON public.prices USING btree (internal_product_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."product_aliases" (
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "alias_id" TEXT NOT NULL,
    "canonical_plan_id" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "public"."product_aliases" ADD CONSTRAINT "product_aliases_pkey" PRIMARY KEY (org_id, env, alias_id);
--> statement-breakpoint
ALTER TABLE "public"."product_aliases" ADD CONSTRAINT "product_aliases_canonical_unique" UNIQUE (org_id, env, canonical_plan_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."products" (
    "internal_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "org_id" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "env" TEXT NOT NULL,
    "is_add_on" BOOLEAN NOT NULL DEFAULT false,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "group" TEXT DEFAULT ''::text,
    "version" NUMERIC NOT NULL DEFAULT 1,
    "processor" JSONB,
    "base_variant_id" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "auto_topups" JSONB,
    "spend_limits" JSONB,
    "usage_limits" JSONB,
    "usage_alerts" JSONB,
    "overage_allowed" JSONB,
    "base_internal_product_id" TEXT,
    "version_slug" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" NUMERIC,
    "previous_version_slug" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."products" ADD CONSTRAINT "products_pkey" PRIMARY KEY (internal_id);
--> statement-breakpoint
ALTER TABLE "public"."products" ADD CONSTRAINT "unique_product" UNIQUE (org_id, id, env, version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_products_org_env_base_internal_product_id ON public.products USING btree (org_id, env, base_internal_product_id) WHERE (base_internal_product_id IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_products_org_env_id_version ON public.products USING btree (org_id, env, id, version)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_product ON public.products USING btree (org_id, id, env) WHERE (active = true)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS unique_product_version_slug ON public.products USING btree (org_id, id, env, version_slug) WHERE (version_slug IS NOT NULL)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."referral_codes" (
    "code" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "internal_customer_id" TEXT COLLATE "C",
    "internal_reward_program_id" TEXT,
    "id" TEXT NOT NULL,
    "created_at" NUMERIC
);
--> statement-breakpoint
ALTER TABLE "public"."referral_codes" ADD CONSTRAINT "referral_codes_pkey" PRIMARY KEY (code, org_id, env);
--> statement-breakpoint
ALTER TABLE "public"."referral_codes" ADD CONSTRAINT "referral_codes_id_key" UNIQUE (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_referral_codes_internal_customer_id ON public.referral_codes USING btree (internal_customer_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."replaceables" (
    "id" TEXT NOT NULL,
    "cus_ent_id" TEXT NOT NULL,
    "created_at" BIGINT NOT NULL,
    "from_entity_id" TEXT,
    "delete_next_cycle" BOOLEAN NOT NULL DEFAULT false
);
--> statement-breakpoint
ALTER TABLE "public"."replaceables" ADD CONSTRAINT "replaceables_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_replaceables_cus_ent_id ON public.replaceables USING btree (cus_ent_id)
--> statement-breakpoint
ALTER TABLE "public"."replaceables" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."reward_programs" (
    "internal_id" TEXT NOT NULL,
    "id" TEXT,
    "created_at" NUMERIC,
    "internal_reward_id" TEXT,
    "max_redemptions" NUMERIC,
    "unlimited_redemptions" BOOLEAN DEFAULT false,
    "org_id" TEXT,
    "env" TEXT,
    "when" TEXT DEFAULT 'immediately'::text,
    "product_ids" TEXT[] DEFAULT '{""}'::text[],
    "exclude_trial" BOOLEAN DEFAULT false,
    "received_by" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."reward_programs" ADD CONSTRAINT "reward_programs_pkey" PRIMARY KEY (internal_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."reward_redemptions" (
    "id" TEXT NOT NULL,
    "created_at" NUMERIC,
    "updated_at" NUMERIC,
    "internal_customer_id" TEXT COLLATE "C",
    "triggered" BOOLEAN,
    "internal_reward_program_id" TEXT,
    "applied" BOOLEAN DEFAULT false,
    "redeemer_applied" BOOLEAN DEFAULT false,
    "referral_code_id" TEXT,
    "reward_internal_id" TEXT,
    "promo_code" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."reward_redemptions" ADD CONSTRAINT "reward_redemptions_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_reward_redemptions_customer_reward ON public.reward_redemptions USING btree (internal_customer_id, reward_internal_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_reward_redemptions_referral_code_id ON public.reward_redemptions USING btree (referral_code_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_reward_redemptions_reward_internal_id ON public.reward_redemptions USING btree (reward_internal_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."rewards" (
    "internal_id" TEXT NOT NULL,
    "id" TEXT,
    "org_id" TEXT,
    "env" TEXT,
    "created_at" NUMERIC,
    "name" TEXT,
    "discount_config" JSONB,
    "free_product_config" JSONB,
    "free_product_id" TEXT,
    "promo_codes" JSONB[],
    "type" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."rewards" ADD CONSTRAINT "rewards_pkey" PRIMARY KEY (internal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rewards_org_id_env ON public.rewards USING btree (org_id, env)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."rollovers" (
    "id" TEXT NOT NULL,
    "cus_ent_id" TEXT NOT NULL,
    "balance" NUMERIC NOT NULL,
    "expires_at" NUMERIC,
    "usage" NUMERIC NOT NULL DEFAULT 0,
    "entities" JSONB NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
ALTER TABLE "public"."rollovers" ADD CONSTRAINT "rollovers_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rollovers_cus_ent_expires ON public.rollovers USING btree (cus_ent_id, expires_at)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rollovers_cus_ent_id ON public.rollovers USING btree (cus_ent_id)
--> statement-breakpoint
ALTER TABLE "public"."rollovers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."schedules" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "internal_customer_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "internal_entity_id" TEXT,
    "entity_id" TEXT,
    "created_at" NUMERIC NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public"."schedules" ADD CONSTRAINT "schedules_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_schedules_internal_customer_id ON public.schedules USING btree (internal_customer_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_schedules_internal_entity_id ON public.schedules USING btree (internal_entity_id)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS schedules_customer_scope_unique ON public.schedules USING btree (org_id, env, internal_customer_id) WHERE (internal_entity_id IS NULL)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS schedules_entity_scope_unique ON public.schedules USING btree (org_id, env, internal_customer_id, internal_entity_id) WHERE (internal_entity_id IS NOT NULL)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."served_model_deployments" (
    "internal_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "provider_model" TEXT NOT NULL,
    "api_base" TEXT,
    "api_key_enc" TEXT NOT NULL,
    "api_key_hint" TEXT NOT NULL,
    "gateway_model_id" TEXT,
    "rpm" NUMERIC,
    "tpm" NUMERIC,
    "created_at" NUMERIC,
    "updated_at" NUMERIC,
    "timeout" NUMERIC,
    "max_retries" NUMERIC,
    "weight" NUMERIC,
    "routing_order" NUMERIC,
    "organization" TEXT,
    "extra_params_enc" TEXT,
    "extra_params_keys" JSONB
);
--> statement-breakpoint
ALTER TABLE "public"."served_model_deployments" ADD CONSTRAINT "served_model_deployments_pkey" PRIMARY KEY (internal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_served_model_deployments_composite ON public.served_model_deployments USING btree (org_id, env, model_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."served_models" (
    "internal_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "display_name" TEXT,
    "upstream_model" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "input_cost_usd_1m" NUMERIC,
    "output_cost_usd_1m" NUMERIC,
    "markup_pct" NUMERIC DEFAULT '0'::numeric,
    "created_at" NUMERIC,
    "updated_at" NUMERIC
);
--> statement-breakpoint
ALTER TABLE "public"."served_models" ADD CONSTRAINT "served_models_pkey" PRIMARY KEY (internal_id);
--> statement-breakpoint
ALTER TABLE "public"."served_models" ADD CONSTRAINT "served_models_org_env_model" UNIQUE (org_id, env, model_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_served_models_composite ON public.served_models USING btree (org_id, env)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."session" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "user_id" TEXT NOT NULL,
    "impersonated_by" TEXT,
    "active_organization_id" TEXT,
    "city" TEXT,
    "country" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."session" ADD CONSTRAINT "session_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."session" ADD CONSTRAINT "session_token_unique" UNIQUE (token);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON public.session USING btree (user_id)
--> statement-breakpoint
ALTER TABLE "public"."session" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."sso_connection" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_domain_verification'::text,
    "activated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public"."sso_connection" ADD CONSTRAINT "sso_connection_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."sso_connection" ADD CONSTRAINT "sso_connection_organization_id_unique" UNIQUE (organization_id);
--> statement-breakpoint
ALTER TABLE "public"."sso_connection" ADD CONSTRAINT "sso_connection_provider_id_unique" UNIQUE (provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sso_connection_organization_id_idx ON public.sso_connection USING btree (organization_id)
--> statement-breakpoint
ALTER TABLE "public"."sso_connection" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."sso_provider" (
    "id" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "oidc_config" TEXT,
    "saml_config" TEXT,
    "user_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "domain_verified" BOOLEAN NOT NULL DEFAULT false
);
--> statement-breakpoint
ALTER TABLE "public"."sso_provider" ADD CONSTRAINT "sso_provider_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."sso_provider" ADD CONSTRAINT "sso_provider_domain_unique" UNIQUE (domain);
--> statement-breakpoint
ALTER TABLE "public"."sso_provider" ADD CONSTRAINT "sso_provider_provider_id_unique" UNIQUE (provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sso_provider_domain_idx ON public.sso_provider USING btree (domain)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sso_provider_organization_id_idx ON public.sso_provider USING btree (organization_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sso_provider_user_id_idx ON public.sso_provider USING btree (user_id)
--> statement-breakpoint
ALTER TABLE "public"."sso_provider" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "processor_id" TEXT,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "metadata" JSONB DEFAULT '{}'::jsonb,
    "usage_features" TEXT[] DEFAULT '{}'::text[],
    "env" TEXT,
    "current_period_start" NUMERIC,
    "current_period_end" NUMERIC,
    "billing_cycle_anchor_seconds" NUMERIC
);
--> statement-breakpoint
ALTER TABLE "public"."subscriptions" ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."subscriptions" ADD CONSTRAINT "subscriptions_processor_id_key" UNIQUE (processor_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."transition_rules" (
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "carry_over_usages" JSONB,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "public"."transition_rules" ADD CONSTRAINT "transition_rules_pkey" PRIMARY KEY (org_id, env);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."usage_windows" (
    "id" TEXT NOT NULL,
    "internal_customer_id" TEXT NOT NULL,
    "internal_entity_id" TEXT,
    "feature_id" TEXT NOT NULL,
    "internal_feature_id" TEXT NOT NULL,
    "anchor_customer_entitlement_id" TEXT,
    "window_start_at" NUMERIC NOT NULL,
    "window_end_at" NUMERIC NOT NULL,
    "usage" NUMERIC NOT NULL DEFAULT 0,
    "updated_at" NUMERIC NOT NULL,
    "filter_key" TEXT
);
--> statement-breakpoint
ALTER TABLE "public"."usage_windows" ADD CONSTRAINT "usage_windows_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_windows_customer_feature_scope ON public.usage_windows USING btree (internal_customer_id, internal_feature_id, COALESCE(internal_entity_id, ''::text), COALESCE(filter_key, ''::text))
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_usage_windows_internal_customer_id ON public.usage_windows USING btree (internal_customer_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_usage_windows_internal_customer_id_c ON public.usage_windows USING btree (internal_customer_id COLLATE "C")
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_uw_internal_feature_id ON public.usage_windows USING btree (internal_feature_id)
--> statement-breakpoint
ALTER TABLE "public"."usage_windows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL,
    "image" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "role" TEXT,
    "banned" BOOLEAN,
    "ban_reason" TEXT,
    "ban_expires" TIMESTAMPTZ,
    "created_by" TEXT,
    "last_active_at" TIMESTAMPTZ
);
--> statement-breakpoint
ALTER TABLE "public"."user" ADD CONSTRAINT "user_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."user" ADD CONSTRAINT "user_email_unique" UNIQUE (email);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_created_at_id ON public."user" USING btree (created_at DESC, id DESC)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_email_trgm ON public."user" USING gin (email gin_trgm_ops) WHERE (email IS NOT NULL)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_name_trgm ON public."user" USING gin (name gin_trgm_ops) WHERE (name IS NOT NULL)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ
);
--> statement-breakpoint
ALTER TABLE "public"."verification" ADD CONSTRAINT "verification_pkey" PRIMARY KEY (id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON public.verification USING btree (identifier)
--> statement-breakpoint
ALTER TABLE "public"."verification" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."wallet_ledger" (
    "id" BIGINT NOT NULL DEFAULT nextval('wallet_ledger_id_seq'::regclass),
    "customer_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_usd" DOUBLE PRECISION,
    "credits_delta" DOUBLE PRECISION,
    "event_name" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "public"."wallet_ledger" ADD CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "public"."wallet_ledger" ADD CONSTRAINT "wallet_ledger_idempotency_key_unique" UNIQUE (idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_customer_created_at ON public.wallet_ledger USING btree (customer_id, created_at)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."webhook_events" (
    "event_id" TEXT NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "public"."webhook_events" ADD CONSTRAINT "webhook_events_pkey" PRIMARY KEY (event_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leaf"."chat_thread_contexts" (
    "id" TEXT NOT NULL,
    "chat_installation_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "org_slug" TEXT,
    "source" TEXT NOT NULL,
    "target_identifier" TEXT,
    "created_by_provider_user_id" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "leaf"."chat_thread_contexts" ADD CONSTRAINT "chat_thread_contexts_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "leaf"."chat_thread_contexts" ADD CONSTRAINT "chat_thread_contexts_thread_key" UNIQUE (workspace_id, channel_id, thread_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leaf"."cma_memory" (
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "memory_store_id" TEXT NOT NULL,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "leaf"."cma_memory" ADD CONSTRAINT "cma_memory_org_id_env_pk" PRIMARY KEY (org_id, env);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leaf"."cma_sessions" (
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "thread_key" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "braintrust_parent" TEXT,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "leaf"."cma_sessions" ADD CONSTRAINT "cma_sessions_org_id_env_thread_key_pk" PRIMARY KEY (org_id, env, thread_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leaf"."cma_vaults" (
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "vault_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "chat_installation_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "user_id" TEXT
);
--> statement-breakpoint
ALTER TABLE "leaf"."cma_vaults" ADD CONSTRAINT "cma_vaults_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "leaf"."cma_vaults" ADD CONSTRAINT "cma_vaults_installation_org_env_user_key" UNIQUE NULLS NOT DISTINCT (chat_installation_id, org_id, env, user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leaf"."harness_sessions" (
    "org_id" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "thread_key" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "resume_state" JSONB,
    "braintrust_parent" TEXT,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "title" TEXT
);
--> statement-breakpoint
ALTER TABLE "leaf"."harness_sessions" ADD CONSTRAINT "harness_sessions_org_id_env_thread_key_pk" PRIMARY KEY (org_id, env, thread_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_harness_sessions_session_id ON leaf.harness_sessions USING btree (session_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leaf"."slack_admin_threads" (
    "id" TEXT NOT NULL,
    "chat_installation_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "org_slug" TEXT,
    "target_identifier" TEXT NOT NULL,
    "created_by_provider_user_id" TEXT NOT NULL,
    "created_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint,
    "updated_at" NUMERIC NOT NULL DEFAULT (round((date_part('epoch'::text, now()) * (1000)::double precision)))::bigint
);
--> statement-breakpoint
ALTER TABLE "leaf"."slack_admin_threads" ADD CONSTRAINT "slack_admin_threads_pkey" PRIMARY KEY (id);
--> statement-breakpoint
ALTER TABLE "leaf"."slack_admin_threads" ADD CONSTRAINT "slack_admin_threads_thread_key" UNIQUE (workspace_id, channel_id, thread_id);
--> statement-breakpoint
ALTER TABLE "public"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."actions" ADD CONSTRAINT "actions_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."actions" ADD CONSTRAINT "actions_entity_id_fkey" FOREIGN KEY (internal_entity_id) REFERENCES entities(internal_id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."actions" ADD CONSTRAINT "actions_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."agent_rules" ADD CONSTRAINT "agent_rules_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."api_keys" ADD CONSTRAINT "api_keys_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."auto_topup_limit_states" ADD CONSTRAINT "auto_topup_limits_internal_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."auto_topup_limit_states" ADD CONSTRAINT "auto_topup_limits_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."chat_approval_writes" ADD CONSTRAINT "chat_approval_writes_approval_id_fkey" FOREIGN KEY (approval_id) REFERENCES chat_approvals(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."chat_approvals" ADD CONSTRAINT "chat_approvals_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."chat_installations" ADD CONSTRAINT "chat_installations_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."chat_oauth_credentials" ADD CONSTRAINT "chat_oauth_credentials_installation_id_fkey" FOREIGN KEY (chat_installation_id) REFERENCES chat_installations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."chat_oauth_credentials" ADD CONSTRAINT "chat_oauth_credentials_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."config_audit_log" ADD CONSTRAINT "config_audit_log_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_entitlements" ADD CONSTRAINT "customer_entitlements_customer_product_id_fkey" FOREIGN KEY (customer_product_id) REFERENCES customer_products(id) ON UPDATE CASCADE ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_entitlements" ADD CONSTRAINT "customer_entitlements_entitlement_id_fkey" FOREIGN KEY (entitlement_id) REFERENCES entitlements(id) ON UPDATE CASCADE ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_entitlements" ADD CONSTRAINT "customer_entitlements_internal_entity_id_fkey" FOREIGN KEY (internal_entity_id) REFERENCES entities(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_entitlements" ADD CONSTRAINT "entitlements_internal_feature_id_fkey" FOREIGN KEY (internal_feature_id) REFERENCES features(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_exports" ADD CONSTRAINT "customer_exports_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_jwt_families" ADD CONSTRAINT "customer_jwt_families_internal_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_licenses" ADD CONSTRAINT "customer_licenses_customer_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_licenses" ADD CONSTRAINT "customer_licenses_license_product_fkey" FOREIGN KEY (license_internal_product_id) REFERENCES products(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_licenses" ADD CONSTRAINT "customer_licenses_parent_customer_product_fkey" FOREIGN KEY (parent_customer_product_id) REFERENCES customer_products(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_licenses" ADD CONSTRAINT "customer_licenses_plan_license_fkey" FOREIGN KEY (plan_license_id) REFERENCES plan_license(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."customer_prices" ADD CONSTRAINT "customer_prices_customer_product_id_fkey" FOREIGN KEY (customer_product_id) REFERENCES customer_products(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_prices" ADD CONSTRAINT "customer_prices_internal_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_prices" ADD CONSTRAINT "customer_prices_price_id_fkey" FOREIGN KEY (price_id) REFERENCES prices(id);
--> statement-breakpoint
ALTER TABLE "public"."customer_products" ADD CONSTRAINT "customer_products_free_trial_id_fkey" FOREIGN KEY (free_trial_id) REFERENCES free_trials(id);
--> statement-breakpoint
ALTER TABLE "public"."customer_products" ADD CONSTRAINT "customer_products_internal_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON UPDATE CASCADE ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."customer_products" ADD CONSTRAINT "customer_products_internal_entity_id_fkey" FOREIGN KEY (internal_entity_id) REFERENCES entities(internal_id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."customer_products" ADD CONSTRAINT "customer_products_internal_product_id_fkey" FOREIGN KEY (internal_product_id) REFERENCES products(internal_id);
--> statement-breakpoint
ALTER TABLE "public"."customers" ADD CONSTRAINT "customers_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."entities" ADD CONSTRAINT "entities_internal_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."entities" ADD CONSTRAINT "entities_internal_feature_id_fkey" FOREIGN KEY (internal_feature_id) REFERENCES features(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."entities" ADD CONSTRAINT "entities_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."entitlements" ADD CONSTRAINT "entitlements_internal_feature_id_fkey" FOREIGN KEY (internal_feature_id) REFERENCES features(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."entitlements" ADD CONSTRAINT "entitlements_internal_product_id_fkey" FOREIGN KEY (internal_product_id) REFERENCES products(internal_id) ON UPDATE CASCADE ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."entitlements" ADD CONSTRAINT "entitlements_internal_reward_id_fkey" FOREIGN KEY (internal_reward_id) REFERENCES rewards(internal_id) ON UPDATE CASCADE ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."events" ADD CONSTRAINT "events_internal_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."features" ADD CONSTRAINT "features_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."free_trials" ADD CONSTRAINT "free_trials_internal_product_id_fkey" FOREIGN KEY (internal_product_id) REFERENCES products(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY (inviter_id) REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."invitation" ADD CONSTRAINT "invitation_organization_id_organizations_id_fk" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."invoice_templates" ADD CONSTRAINT "invoice_templates_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."invoices" ADD CONSTRAINT "invoices_internal_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."invoices" ADD CONSTRAINT "invoices_internal_entity_id_fkey" FOREIGN KEY (internal_entity_id) REFERENCES entities(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."license_entitlements" ADD CONSTRAINT "license_entitlements_entitlement_fkey" FOREIGN KEY (entitlement_id) REFERENCES entitlements(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "public"."license_entitlements" ADD CONSTRAINT "license_entitlements_plan_license_fkey" FOREIGN KEY (plan_license_id) REFERENCES plan_license(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."license_prices" ADD CONSTRAINT "license_prices_plan_license_fkey" FOREIGN KEY (plan_license_id) REFERENCES plan_license(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."license_prices" ADD CONSTRAINT "license_prices_price_fkey" FOREIGN KEY (price_id) REFERENCES prices(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "public"."member" ADD CONSTRAINT "member_organization_id_organizations_id_fk" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."migration_errors" ADD CONSTRAINT "migration_customers_internal_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."migration_errors" ADD CONSTRAINT "migration_customers_migration_job_id_fkey" FOREIGN KEY (migration_job_id) REFERENCES migration_jobs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."migration_jobs" ADD CONSTRAINT "migration_jobs_from_internal_product_id_fkey" FOREIGN KEY (from_internal_product_id) REFERENCES products(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."migration_jobs" ADD CONSTRAINT "migration_jobs_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."migration_jobs" ADD CONSTRAINT "migration_jobs_to_internal_product_id_fkey" FOREIGN KEY (to_internal_product_id) REFERENCES products(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."migration_runs" ADD CONSTRAINT "migration_runs_migration_internal_id_fkey" FOREIGN KEY (migration_internal_id) REFERENCES migrations(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."migration_runs" ADD CONSTRAINT "migration_runs_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."migrations" ADD CONSTRAINT "migrations_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_client_id_oauth_client_client_id_fk" FOREIGN KEY (client_id) REFERENCES oauth_client(client_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_oauth_consent_id_oauth_consent_id_fk" FOREIGN KEY (oauth_consent_id) REFERENCES oauth_consent(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_refresh_id_oauth_refresh_token_id_fk" FOREIGN KEY (refresh_id) REFERENCES oauth_refresh_token(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_session_id_session_id_fk" FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."oauth_access_token" ADD CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."oauth_client" ADD CONSTRAINT "oauth_client_user_id_user_id_fk" FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."oauth_consent" ADD CONSTRAINT "oauth_consent_client_id_oauth_client_client_id_fk" FOREIGN KEY (client_id) REFERENCES oauth_client(client_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."oauth_consent" ADD CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_client_id_oauth_client_client_id_fk" FOREIGN KEY (client_id) REFERENCES oauth_client(client_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_oauth_consent_id_oauth_consent_id_fk" FOREIGN KEY (oauth_consent_id) REFERENCES oauth_consent(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_session_id_session_id_fk" FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."oauth_refresh_token" ADD CONSTRAINT "oauth_refresh_token_user_id_user_id_fk" FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."phases" ADD CONSTRAINT "phases_schedule_id_fkey" FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."plan_license" ADD CONSTRAINT "plan_license_license_product_fkey" FOREIGN KEY (license_internal_product_id) REFERENCES products(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."plan_license" ADD CONSTRAINT "plan_license_parent_product_fkey" FOREIGN KEY (parent_internal_product_id) REFERENCES products(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."pooled_balance_contributions" ADD CONSTRAINT "pooled_balance_contributions_customer_entitlement_fkey" FOREIGN KEY (source_customer_entitlement_id) REFERENCES customer_entitlements(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."pooled_balance_contributions" ADD CONSTRAINT "pooled_balance_contributions_customer_product_fkey" FOREIGN KEY (source_customer_product_id) REFERENCES customer_products(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."pooled_balance_contributions" ADD CONSTRAINT "pooled_balance_contributions_pool_fkey" FOREIGN KEY (pooled_balance_id) REFERENCES pooled_balances(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."pooled_balances" ADD CONSTRAINT "pooled_balances_customer_entitlement_fkey" FOREIGN KEY (customer_entitlement_id) REFERENCES customer_entitlements(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "public"."pooled_balances" ADD CONSTRAINT "pooled_balances_customer_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."pooled_balances" ADD CONSTRAINT "pooled_balances_feature_fkey" FOREIGN KEY (internal_feature_id) REFERENCES features(internal_id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "public"."prices" ADD CONSTRAINT "prices_entitlement_id_fkey" FOREIGN KEY (entitlement_id) REFERENCES entitlements(id);
--> statement-breakpoint
ALTER TABLE "public"."prices" ADD CONSTRAINT "prices_internal_product_id_fkey" FOREIGN KEY (internal_product_id) REFERENCES products(internal_id) ON UPDATE CASCADE ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."product_aliases" ADD CONSTRAINT "product_aliases_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."products" ADD CONSTRAINT "products_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."referral_codes" ADD CONSTRAINT "referral_codes_internal_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."referral_codes" ADD CONSTRAINT "referral_codes_internal_reward_program_id_fkey" FOREIGN KEY (internal_reward_program_id) REFERENCES reward_programs(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."referral_codes" ADD CONSTRAINT "referral_codes_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."replaceables" ADD CONSTRAINT "replaceables_cus_ent_id_fkey" FOREIGN KEY (cus_ent_id) REFERENCES customer_entitlements(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."reward_programs" ADD CONSTRAINT "reward_triggers_internal_reward_id_fkey" FOREIGN KEY (internal_reward_id) REFERENCES rewards(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."reward_programs" ADD CONSTRAINT "reward_triggers_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."reward_redemptions" ADD CONSTRAINT "reward_redemptions_internal_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."reward_redemptions" ADD CONSTRAINT "reward_redemptions_internal_reward_program_id_fkey" FOREIGN KEY (internal_reward_program_id) REFERENCES reward_programs(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."reward_redemptions" ADD CONSTRAINT "reward_redemptions_referral_code_id_fkey" FOREIGN KEY (referral_code_id) REFERENCES referral_codes(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."rewards" ADD CONSTRAINT "coupons_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."rollovers" ADD CONSTRAINT "rollover_cus_ent_id_fkey" FOREIGN KEY (cus_ent_id) REFERENCES customer_entitlements(id) ON UPDATE CASCADE ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."schedules" ADD CONSTRAINT "schedules_internal_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."schedules" ADD CONSTRAINT "schedules_internal_entity_id_fkey" FOREIGN KEY (internal_entity_id) REFERENCES entities(internal_id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."schedules" ADD CONSTRAINT "schedules_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."served_model_deployments" ADD CONSTRAINT "served_model_deployments_model_fkey" FOREIGN KEY (org_id, env, model_id) REFERENCES served_models(org_id, env, model_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."served_model_deployments" ADD CONSTRAINT "served_model_deployments_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."served_models" ADD CONSTRAINT "served_models_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."sso_connection" ADD CONSTRAINT "sso_connection_organization_id_organizations_id_fk" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."sso_connection" ADD CONSTRAINT "sso_connection_provider_id_sso_provider_provider_id_fk" FOREIGN KEY (provider_id) REFERENCES sso_provider(provider_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."sso_provider" ADD CONSTRAINT "sso_provider_organization_id_organizations_id_fk" FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."sso_provider" ADD CONSTRAINT "sso_provider_user_id_user_id_fk" FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."subscriptions" ADD CONSTRAINT "subscriptions_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."transition_rules" ADD CONSTRAINT "transition_rules_org_id_fkey" FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."usage_windows" ADD CONSTRAINT "usage_windows_anchor_customer_entitlement_id_fkey" FOREIGN KEY (anchor_customer_entitlement_id) REFERENCES customer_entitlements(id) ON UPDATE CASCADE ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "public"."usage_windows" ADD CONSTRAINT "usage_windows_internal_customer_id_fkey" FOREIGN KEY (internal_customer_id) REFERENCES customers(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."usage_windows" ADD CONSTRAINT "usage_windows_internal_entity_id_fkey" FOREIGN KEY (internal_entity_id) REFERENCES entities(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."usage_windows" ADD CONSTRAINT "usage_windows_internal_feature_id_fkey" FOREIGN KEY (internal_feature_id) REFERENCES features(internal_id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "public"."user" ADD CONSTRAINT "user_created_by_fkey" FOREIGN KEY (created_by) REFERENCES organizations(id);
