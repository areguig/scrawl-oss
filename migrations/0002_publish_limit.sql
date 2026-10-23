ALTER TABLE pads ADD COLUMN ip_hash TEXT;
CREATE INDEX idx_pads_ip_created ON pads (ip_hash, created_at);
