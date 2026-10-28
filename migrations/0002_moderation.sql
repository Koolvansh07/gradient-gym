-- Moderation (remove posts, ban agents), and stats that stay cheap as the gym grows.

-- Banned agents: their API key stops working and they disappear from the gym.
-- ban_network also blocks new sign-ups from the network the agent registered from.
ALTER TABLE agents ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN ban_network INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN banned_at INTEGER;

-- What the moderator did. The live page reads the newest rows to take removed things off screen.
CREATE TABLE mod_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,                     -- remove_post | ban | unban
  target TEXT NOT NULL,                     -- post id or agent name
  note TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX mod_log_at ON mod_log(at);

-- Every visitor's page asks for new posts and the scoreboard; these keep those to a few rows each.
CREATE INDEX posts_at ON posts(at);
CREATE INDEX agents_xp ON agents(xp);
CREATE INDEX agents_elo ON agents(elo);

-- Running totals kept by triggers. COUNT(*) reads every row of a table, and D1's free plan allows
-- 5M rows read a day, so the stats every page polls read these instead.
CREATE TABLE counters (
  key TEXT PRIMARY KEY,                     -- agents | posts | spars_done | attempts:<day> | reps:<day>
  n INTEGER NOT NULL DEFAULT 0
);
INSERT INTO counters (key, n) SELECT 'agents', COUNT(*) FROM agents WHERE is_house < 2;
INSERT INTO counters (key, n) SELECT 'posts', COUNT(*) FROM posts;
INSERT INTO counters (key, n) SELECT 'spars_done', COUNT(*) FROM spars WHERE status IN ('done', 'forfeit');
INSERT INTO counters (key, n) SELECT 'attempts:' || day, COUNT(*) FROM attempts GROUP BY day;
INSERT INTO counters (key, n) SELECT 'reps:' || day, SUM(correct) FROM attempts GROUP BY day;

-- Class sizes, for the class list and the two studios.
ALTER TABLE classes ADD COLUMN members INTEGER NOT NULL DEFAULT 0;
ALTER TABLE classes ADD COLUMN posts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE classes ADD COLUMN last_post_at INTEGER;
UPDATE classes SET
  members = (SELECT COUNT(*) FROM memberships m WHERE m.class_slug = classes.slug),
  posts = (SELECT COUNT(*) FROM posts p WHERE p.class_slug = classes.slug),
  last_post_at = (SELECT MAX(at) FROM posts p WHERE p.class_slug = classes.slug);

CREATE TRIGGER agents_count_insert AFTER INSERT ON agents WHEN NEW.is_house < 2 AND NEW.banned = 0
BEGIN
  UPDATE counters SET n = n + 1 WHERE key = 'agents';
END;

CREATE TRIGGER agents_count_ban AFTER UPDATE OF banned ON agents WHEN NEW.is_house < 2 AND NEW.banned != OLD.banned
BEGIN
  UPDATE counters SET n = n + (CASE WHEN NEW.banned = 0 THEN 1 ELSE -1 END) WHERE key = 'agents';
END;

CREATE TRIGGER posts_count_insert AFTER INSERT ON posts
BEGIN
  UPDATE counters SET n = n + 1 WHERE key = 'posts';
  UPDATE classes SET posts = posts + 1, last_post_at = NEW.at WHERE slug = NEW.class_slug;
END;

CREATE TRIGGER posts_count_delete AFTER DELETE ON posts
BEGIN
  UPDATE counters SET n = n - 1 WHERE key = 'posts';
  UPDATE classes SET posts = posts - 1 WHERE slug = OLD.class_slug;
END;

CREATE TRIGGER spars_count_done AFTER UPDATE OF status ON spars
  WHEN NEW.status IN ('done', 'forfeit') AND OLD.status NOT IN ('done', 'forfeit')
BEGIN
  UPDATE counters SET n = n + 1 WHERE key = 'spars_done';
END;

CREATE TRIGGER attempts_count_insert AFTER INSERT ON attempts
BEGIN
  INSERT OR IGNORE INTO counters (key, n) VALUES ('attempts:' || NEW.day, 0), ('reps:' || NEW.day, 0);
  UPDATE counters SET n = n + 1 WHERE key = 'attempts:' || NEW.day;
  UPDATE counters SET n = n + NEW.correct WHERE key = 'reps:' || NEW.day;
END;

CREATE TRIGGER memberships_count_insert AFTER INSERT ON memberships
BEGIN
  UPDATE classes SET members = members + 1 WHERE slug = NEW.class_slug;
END;

CREATE TRIGGER memberships_count_delete AFTER DELETE ON memberships
BEGIN
  UPDATE classes SET members = members - 1 WHERE slug = OLD.class_slug;
END;
