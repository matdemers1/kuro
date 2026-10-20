-- AnimeSchedule.net timetables and routes (KURO-T-3.1), and the sequel a Show is waiting on (KURO-T-3.4).
ALTER TABLE "show_state" ADD COLUMN "coming_entry_id" TEXT;

CREATE TABLE "schedule_entry" (
    "week" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "air_type" TEXT NOT NULL,
    "episode_number" INTEGER NOT NULL DEFAULT 0,
    "episode_date" TIMESTAMPTZ(6),
    "title" TEXT NOT NULL,
    "english" TEXT,
    "episodes" INTEGER,
    "status" TEXT,
    "delayed_until" TIMESTAMPTZ(6),
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "schedule_entry_pkey" PRIMARY KEY ("week","route","air_type","episode_number")
);
CREATE INDEX "schedule_entry_route_idx" ON "schedule_entry"("route");

CREATE TABLE "schedule_anime" (
    "route" TEXT NOT NULL,
    "anilist_id" INTEGER,
    "mal_id" INTEGER,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "schedule_anime_pkey" PRIMARY KEY ("route")
);
CREATE INDEX "schedule_anime_anilist_id_idx" ON "schedule_anime"("anilist_id");
