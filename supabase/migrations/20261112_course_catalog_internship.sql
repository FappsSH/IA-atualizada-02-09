ALTER TABLE course_catalog_entries
  ADD COLUMN IF NOT EXISTS has_internship BOOLEAN NOT NULL DEFAULT false;

UPDATE course_catalog_entries
SET has_internship = (
  degree_level = 'licenciatura'
  OR (
    degree_level = 'bacharelado'
    AND (
      COALESCE(area_slug, '') ILIKE '%saude%'
      OR COALESCE(area_name, '') ILIKE '%saude%'
    )
  )
);
