-- Nightly backups and their restore checks (KURO-T-6.2).
CREATE TABLE "backup_run" (
    "id" UUID NOT NULL,
    "file" TEXT,
    "size_bytes" BIGINT,
    "check" TEXT NOT NULL,
    "detail" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "backup_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "backup_run_check_check" CHECK ("check" IN ('ok', 'failed', 'error'))
);
CREATE INDEX "backup_run_started_at_idx" ON "backup_run"("started_at");
