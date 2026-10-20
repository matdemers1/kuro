-- The open anime catalog (KURO-ADR-002): imported releases and their entries.
CREATE TABLE "catalog_release" (
    "id" UUID NOT NULL,
    "repo" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "imported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entries" INTEGER NOT NULL,
    "added" INTEGER NOT NULL,
    "retired" INTEGER NOT NULL,

    CONSTRAINT "catalog_release_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "catalog_entry" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "episodes" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "season" TEXT,
    "season_year" INTEGER,
    "duration_s" INTEGER,
    "picture" TEXT,
    "thumbnail" TEXT,
    "synonyms" TEXT[],
    "sources" TEXT[],
    "related" TEXT[],
    "tags" TEXT[],
    "studios" TEXT[],
    "anilist_id" INTEGER,
    "mal_id" INTEGER,
    "retired_at" TIMESTAMPTZ(6),
    "release_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "catalog_entry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "catalog_release_repo_tag_key" ON "catalog_release"("repo", "tag");
CREATE INDEX "catalog_entry_anilist_id_idx" ON "catalog_entry"("anilist_id");
CREATE INDEX "catalog_entry_mal_id_idx" ON "catalog_entry"("mal_id");
CREATE INDEX "catalog_entry_retired_at_idx" ON "catalog_entry"("retired_at");
