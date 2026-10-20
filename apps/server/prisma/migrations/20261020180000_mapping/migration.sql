-- Crunchyroll episode ranges mapped onto catalog entries (KURO-ADR-003).
CREATE TABLE "mapping" (
    "id" UUID NOT NULL,
    "cr_season_id" TEXT NOT NULL,
    "ep_from" INTEGER NOT NULL,
    "ep_to" INTEGER NOT NULL,
    "catalog_entry_id" TEXT,
    "offset" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "status" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "signals" TEXT[],
    "candidates" TEXT[],
    "auto_entry_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mapping_cr_season_id_ep_from_key" ON "mapping"("cr_season_id", "ep_from");
CREATE INDEX "mapping_status_idx" ON "mapping"("status");
CREATE INDEX "mapping_catalog_entry_id_idx" ON "mapping"("catalog_entry_id");
