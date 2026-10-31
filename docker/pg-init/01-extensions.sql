-- MeterPal: extensions required by the billing schema (gin_trgm_ops index
-- on customers.email and any fuzzy search). Applied on first container init.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
