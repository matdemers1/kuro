-- When a run's plays were matched and derived state rebuilt (the import is done for the owner).
ALTER TABLE "sync_run" ADD COLUMN "derived_at" TIMESTAMPTZ(6);
