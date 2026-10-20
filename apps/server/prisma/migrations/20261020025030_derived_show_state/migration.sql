-- CreateEnum
CREATE TYPE "ShowStatus" AS ENUM ('plan_to_watch', 'watching', 'caught_up', 'paused', 'completed', 'dropped', 'rewatching');

-- CreateTable
CREATE TABLE "show_state" (
    "show_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ShowStatus" NOT NULL,
    "watched_episodes" INTEGER NOT NULL,
    "total_episodes" INTEGER NOT NULL,
    "remaining_s" INTEGER NOT NULL,
    "current_season" INTEGER,
    "current_episode" INTEGER,
    "next_season" INTEGER,
    "next_episode" INTEGER,
    "next_cr_episode_id" TEXT,
    "next_audio_locale" TEXT,
    "next_title" TEXT,
    "next_is_new" BOOLEAN NOT NULL DEFAULT false,
    "next_is_new_season" BOOLEAN NOT NULL DEFAULT false,
    "last_played_at" TIMESTAMPTZ(6),
    "derived_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "show_state_pkey" PRIMARY KEY ("show_key")
);

-- CreateTable
CREATE TABLE "show_preference" (
    "show_key" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "show_preference_pkey" PRIMARY KEY ("show_key")
);

-- CreateIndex
CREATE INDEX "show_state_status_idx" ON "show_state"("status");
