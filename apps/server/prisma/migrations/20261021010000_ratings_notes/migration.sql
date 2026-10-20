-- Ratings, drop reasons and notes (KURO-T-4.1, KURO-T-4.3).
ALTER TABLE "show_preference" ADD COLUMN "drop_reason" TEXT;

CREATE TABLE "rating" (
    "target" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rating_pkey" PRIMARY KEY ("target"),
    CONSTRAINT "rating_score_range" CHECK ("score" BETWEEN 1 AND 10)
);

CREATE TABLE "show_note" (
    "show_key" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "show_note_pkey" PRIMARY KEY ("show_key")
);
