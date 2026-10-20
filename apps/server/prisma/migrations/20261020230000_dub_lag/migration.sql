-- Dub lag (KURO-T-3.3): which audio languages each episode is out in, and how far a Show's dub trails.
ALTER TABLE "cr_episode" ADD COLUMN "audio_locales" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "show_state" ADD COLUMN "dub_lag" INTEGER NOT NULL DEFAULT 0;

-- What resolve has already fetched: the versions are in the raw episode.
UPDATE "cr_episode" SET "audio_locales" = ARRAY(
  SELECT DISTINCT v->>'audio_locale' FROM jsonb_array_elements(CASE WHEN jsonb_typeof("raw"->'versions') = 'array' THEN "raw"->'versions' ELSE '[]'::jsonb END) AS v
  WHERE v->>'audio_locale' IS NOT NULL
  UNION SELECT "audio_locale" WHERE "audio_locale" IS NOT NULL
);
