-- The owner's Crunchyroll watchlist and Crunchylists, as series to watch (KURO-T-3.5).
CREATE TABLE "plan_entry" (
    "cr_series_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "list_title" TEXT,
    "synced_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plan_entry_pkey" PRIMARY KEY ("cr_series_id","source")
);
