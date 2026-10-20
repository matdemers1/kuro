-- The recommender (KURO-T-4.4, KURO-T-4.5): the catalog's score as a quality prior, Not interested,
-- and the owner's edits to the taste profile.
ALTER TABLE "catalog_entry" ADD COLUMN "score" DOUBLE PRECISION;

CREATE TABLE "rec_dismissal" (
    "catalog_entry_id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rec_dismissal_pkey" PRIMARY KEY ("catalog_entry_id")
);

CREATE TABLE "taste_term" (
    "term" TEXT NOT NULL,
    "adjust" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "taste_term_pkey" PRIMARY KEY ("term"),
    CONSTRAINT "taste_term_adjust_check" CHECK ("adjust" IN ('boost', 'lower', 'mute'))
);
