-- CreateEnum
CREATE TYPE "AuthMethod" AS ENUM ('password', 'oidc');

-- CreateEnum
CREATE TYPE "ThrottleScope" AS ENUM ('account', 'ip');

-- CreateEnum
CREATE TYPE "CrConnectionState" AS ENUM ('linked', 'paused', 'blocked');

-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('backfill', 'delta');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('running', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "CrParentType" AS ENUM ('series', 'movie_listing');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential" (
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totp_secret" TEXT,
    "totp_confirmed_at" TIMESTAMPTZ(6),
    "totp_last_step" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credential_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "identity" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "iss" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "claims" JSONB,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "method" "AuthMethod" NOT NULL,
    "id_token_sub" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_throttle" (
    "scope" "ThrottleScope" NOT NULL,
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "next_allowed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_failure_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_throttle_pkey" PRIMARY KEY ("scope","key")
);

-- CreateTable
CREATE TABLE "cr_connection" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "profile_id" TEXT,
    "device_id" TEXT NOT NULL,
    "refresh_token_ciphertext" TEXT NOT NULL,
    "refresh_token_nonce" TEXT NOT NULL,
    "state" "CrConnectionState" NOT NULL DEFAULT 'linked',
    "state_reason" TEXT,
    "high_water_mark" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cr_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_run" (
    "id" UUID NOT NULL,
    "cr_connection_id" UUID NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'running',
    "last_page" INTEGER NOT NULL DEFAULT 0,
    "pages_total" INTEGER,
    "plays_observed" INTEGER NOT NULL DEFAULT 0,
    "plays_new" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "play" (
    "id" UUID NOT NULL,
    "cr_episode_id" TEXT NOT NULL,
    "cr_parent_id" TEXT NOT NULL,
    "cr_parent_type" "CrParentType" NOT NULL,
    "date_played" TIMESTAMPTZ(6) NOT NULL,
    "playhead_s" INTEGER NOT NULL,
    "fully_watched" BOOLEAN NOT NULL,
    "raw" JSONB NOT NULL,
    "sync_run_id" UUID NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "play_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cr_series" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug_title" TEXT,
    "description" TEXT,
    "raw" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cr_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cr_season" (
    "id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "season_number" INTEGER NOT NULL,
    "season_sequence_number" DOUBLE PRECISION,
    "audio_locale" TEXT,
    "raw" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cr_season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cr_episode" (
    "id" TEXT NOT NULL,
    "season_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "episode_number" INTEGER,
    "sequence_number" DOUBLE PRECISION NOT NULL,
    "duration_s" INTEGER NOT NULL,
    "audio_locale" TEXT,
    "air_date" TIMESTAMPTZ(6),
    "credits_start_s" INTEGER,
    "canonical_id" TEXT,
    "raw" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cr_episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_log" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "undoes_id" UUID,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "identity_user_id_idx" ON "identity"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "identity_iss_sub_key" ON "identity"("iss", "sub");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_expires_at_idx" ON "session"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "cr_connection_user_id_key" ON "cr_connection"("user_id");

-- CreateIndex
CREATE INDEX "sync_run_cr_connection_id_started_at_idx" ON "sync_run"("cr_connection_id", "started_at");

-- CreateIndex
CREATE INDEX "play_date_played_idx" ON "play"("date_played");

-- CreateIndex
CREATE INDEX "play_cr_parent_id_idx" ON "play"("cr_parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "play_cr_episode_id_date_played_key" ON "play"("cr_episode_id", "date_played");

-- CreateIndex
CREATE INDEX "cr_season_series_id_idx" ON "cr_season"("series_id");

-- CreateIndex
CREATE INDEX "cr_episode_season_id_idx" ON "cr_episode"("season_id");

-- CreateIndex
CREATE INDEX "cr_episode_canonical_id_idx" ON "cr_episode"("canonical_id");

-- CreateIndex
CREATE UNIQUE INDEX "change_log_undoes_id_key" ON "change_log"("undoes_id");

-- CreateIndex
CREATE INDEX "change_log_entity_entity_id_idx" ON "change_log"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "change_log_at_idx" ON "change_log"("at");

-- AddForeignKey
ALTER TABLE "credential" ADD CONSTRAINT "credential_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity" ADD CONSTRAINT "identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cr_connection" ADD CONSTRAINT "cr_connection_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_cr_connection_id_fkey" FOREIGN KEY ("cr_connection_id") REFERENCES "cr_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "play" ADD CONSTRAINT "play_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cr_season" ADD CONSTRAINT "cr_season_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "cr_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cr_episode" ADD CONSTRAINT "cr_episode_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "cr_season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_undoes_id_fkey" FOREIGN KEY ("undoes_id") REFERENCES "change_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── The History Vault is append-only (KURO-REQ-004) ───────────────────────
-- Nothing updates or deletes a play — not the app, not a migration, not a hand-run query. History
-- Crunchyroll later forgets stays here. A real correction is a new observation, never an edit.
CREATE FUNCTION "play_is_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'play is append-only: % refused (KURO-REQ-004)', TG_OP;
END;
$$;

CREATE TRIGGER "play_append_only"
  BEFORE UPDATE OR DELETE ON "play"
  FOR EACH ROW EXECUTE FUNCTION "play_is_append_only"();

-- TRUNCATE skips row triggers, so it gets its own statement trigger.
CREATE TRIGGER "play_no_truncate"
  BEFORE TRUNCATE ON "play"
  FOR EACH STATEMENT EXECUTE FUNCTION "play_is_append_only"();
