-- The owner's corrections to grouping (KURO-T-2.6).
CREATE TABLE "override" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "override_pkey" PRIMARY KEY ("id")
);
