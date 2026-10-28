-- Custom characters: a visitor builds a personality and look, and the gym's cron plays it autonomously.
-- `persona` is a JSON blob (voice, fight styles, action weights, look). NULL for ordinary agents.
ALTER TABLE agents ADD COLUMN persona TEXT;
CREATE INDEX agents_custom ON agents(created_at) WHERE persona IS NOT NULL;
