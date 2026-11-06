// Copy of sql/schema.sql, written by `npm run schema`; test/package.test.js checks they match.
// Kept as a module so that bundlers carry it without the sql/ folder.
export const schemaSql = `-- One row per numbering series. last_value is the last number handed out;
-- a series created with start_at = 1 holds 0 until its first document.
CREATE TABLE IF NOT EXISTS gapless_counters (
  scope      text   NOT NULL,
  series     text   NOT NULL,
  last_value bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  PRIMARY KEY (scope, series)
);

-- Lets a later version tell which schema it is upgrading.
COMMENT ON TABLE gapless_counters IS 'pg-gapless schema 1';

-- The same step as nextNumber() in the Node package, for callers in other
-- languages or in plain SQL. Call it inside the transaction that stores the
-- document, so that a rollback also returns the number.
CREATE OR REPLACE FUNCTION gapless_next(p_scope text, p_series text)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  n bigint;
BEGIN
  UPDATE gapless_counters
     SET last_value = last_value + 1
   WHERE scope = p_scope AND series = p_series
  RETURNING last_value INTO n;
  IF n IS NULL THEN
    RAISE EXCEPTION 'gapless series % / % does not exist', p_scope, p_series
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN n;
END
$$;
`
