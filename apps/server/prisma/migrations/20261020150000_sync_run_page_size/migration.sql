-- The page size last_page counts in, so a resumed backfill can change page size (Crunchyroll caps the page number).
ALTER TABLE "sync_run" ADD COLUMN "page_size" INTEGER NOT NULL DEFAULT 100;
