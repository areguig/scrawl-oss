ALTER TABLE pads ADD COLUMN ttl_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE pads ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;

-- Pads published before expiry existed get 30 days from this release.
UPDATE pads SET expires_at = (unixepoch() + 30 * 86400) * 1000;
