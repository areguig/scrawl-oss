ALTER TABLE images ADD COLUMN sha256 TEXT;
CREATE INDEX idx_images_pad_sha ON images (pad_id, sha256);
