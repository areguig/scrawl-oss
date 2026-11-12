-- Comments become annotations pinned to a spot on the page, open only while the pad's author holds a review.
ALTER TABLE comments RENAME TO annotations;
ALTER TABLE annotations ADD COLUMN selector TEXT;
ALTER TABLE annotations ADD COLUMN fx REAL;
ALTER TABLE annotations ADD COLUMN fy REAL;
ALTER TABLE annotations ADD COLUMN snippet TEXT;
ALTER TABLE pads ADD COLUMN review_until INTEGER;
