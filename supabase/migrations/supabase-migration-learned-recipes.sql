-- Global, self-learning "add to basket" checkout recipes (api/services/browser-learned-recipes.js).
-- One row per host; the vision loop learns this only from its own successful runs (a click
-- whose text matched an add-to-basket pattern and the basket count actually incremented right
-- after). Shared across all users. Safe to run repeatedly. Works in-memory without this table
-- applied — persistence is best-effort, same as browser_fastpaths.
CREATE TABLE IF NOT EXISTS browser_learned_recipes (
  host       text PRIMARY KEY,
  selector   text NOT NULL,
  learned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
