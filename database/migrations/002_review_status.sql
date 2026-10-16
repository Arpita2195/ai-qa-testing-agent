ALTER TABLE test_cases
ADD COLUMN review_status text NOT NULL DEFAULT 'approved'
CHECK (review_status IN ('pending', 'approved', 'rejected'));
