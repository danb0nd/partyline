-- Partyline is a scratchpad agents read when asked — no outbound bot hooks.
ALTER TABLE bots DROP COLUMN webhook_url;
ALTER TABLE bots DROP COLUMN webhook_secret;
