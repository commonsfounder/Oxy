-- Debug builds register sandbox push tokens, TestFlight/App Store builds register production ones.
-- Each device records which Apple push server its token belongs to.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS apns_environment TEXT;
