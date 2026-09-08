-- Human email+password auth. Existing users stay; they sign up again or keep an old session.
ALTER TABLE users ADD COLUMN password_hash TEXT;
