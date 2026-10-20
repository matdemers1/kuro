-- Rewatches, derived from plays, and the owner's rewatch queue (KURO-T-4.2).
CREATE TABLE "rewatch" (
    "show_key" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "rewatch_pkey" PRIMARY KEY ("show_key","started_at")
);

CREATE TABLE "rewatch_queue" (
    "show_key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "reason" TEXT,
    "start_entry_id" TEXT,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rewatch_queue_pkey" PRIMARY KEY ("show_key")
);
CREATE INDEX "rewatch_queue_position_idx" ON "rewatch_queue"("position");
