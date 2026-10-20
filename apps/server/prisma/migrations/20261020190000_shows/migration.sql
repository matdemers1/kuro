-- Shows and their Seasons and Extras (KURO-T-2.5): derived, rebuilt whole with show_state.
CREATE TABLE "show" (
    "show_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "franchise_key" TEXT NOT NULL,
    "series_ids" TEXT[],
    "derived_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "show_pkey" PRIMARY KEY ("show_key")
);

CREATE TABLE "show_item" (
    "show_key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "catalog_entry_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL,

    CONSTRAINT "show_item_pkey" PRIMARY KEY ("show_key","position")
);

CREATE INDEX "show_franchise_key_idx" ON "show"("franchise_key");
CREATE INDEX "show_item_catalog_entry_id_idx" ON "show_item"("catalog_entry_id");

ALTER TABLE "show_item" ADD CONSTRAINT "show_item_show_key_fkey" FOREIGN KEY ("show_key") REFERENCES "show"("show_key") ON DELETE CASCADE ON UPDATE CASCADE;
