-- The filler guide (KURO-T-5.3, KURO-ADR-012): animefillerlist.com's episode guides for the
-- owner's long Shows, and a per-Show switch to skip filler.
ALTER TABLE "show_preference" ADD COLUMN "skip_filler" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "filler_list" (
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "filler_list_pkey" PRIMARY KEY ("slug")
);

CREATE TABLE "filler_episode" (
    "slug" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "filler_episode_pkey" PRIMARY KEY ("slug","number"),
    CONSTRAINT "filler_episode_kind_check" CHECK ("kind" IN ('canon', 'mixed', 'filler', 'anime_canon'))
);

ALTER TABLE "filler_episode" ADD CONSTRAINT "filler_episode_slug_fkey" FOREIGN KEY ("slug") REFERENCES "filler_list"("slug") ON DELETE CASCADE ON UPDATE CASCADE;
