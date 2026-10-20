-- The owner's own status for a Show: Plan to watch or Dropped (KURO-REQ-033).
ALTER TABLE "show_preference" ADD COLUMN "status" TEXT;
ALTER TABLE "show_preference" ADD COLUMN "status_at" TIMESTAMPTZ(6);
