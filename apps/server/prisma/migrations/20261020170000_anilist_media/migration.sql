-- AniList records for owned catalog entries, cached forever (KURO-ADR-002).
CREATE TABLE "anilist_media" (
    "anilist_id" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anilist_media_pkey" PRIMARY KEY ("anilist_id")
);
