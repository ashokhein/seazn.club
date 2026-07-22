-- #229 P0-2: make webhook event claiming atomic.
--
-- The webhook used to SELECT billing_events, then INSERT ... ON CONFLICT DO
-- NOTHING but always run the handler. Two concurrent deliveries of the same
-- event both saw no row and both ran the side effects (a second dunning
-- analytics event, a second email), even though only one inserted the ledger
-- row. runEvent now claims an event atomically with a lease: it inserts a fresh
-- row (leased now) or takes over a row that is still unprocessed AND whose lease
-- has expired (a crashed attempt), and only the claimant runs the handler.
--
-- processing_started_at is that lease. Null on a legacy row means "no live
-- lease" so the stuck-event sweeper (hourly, > 10 minutes old) can always take
-- it over; once claimed it holds the lease for the lease window, which is
-- shorter than the sweep interval so a genuine crash is still recovered.
alter table billing_events
  add column if not exists processing_started_at timestamptz;
