-- V303: one trial per org (V277) missed staff-granted trials. extendTrial wrote
-- trial_end without stamping trial_used_at, so an org that took an admin-granted
-- trial could downgrade and get a fresh 14-day checkout trial afterwards. The
-- code now stamps at grant time; this closes the orgs already in that state.
--
-- The grant date is not recorded anywhere, so the stamp lands on updated_at
-- (the grant is what last wrote the row in every observed case). Only the
-- existence of a stamp is read — checkoutTrialDays is a null check.
update subscriptions
   set trial_used_at = coalesce(updated_at, now())
 where trial_end is not null
   and trial_used_at is null;
