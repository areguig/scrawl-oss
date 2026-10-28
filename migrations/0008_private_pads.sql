-- The random token a private pad's link carries; NULL for public pads.
ALTER TABLE pads ADD COLUMN link_key TEXT;
