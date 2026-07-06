-- =============================================================================
-- Migration 241: product tour
-- =============================================================================

-- Track when a user completes (or skips) the in-app product tour.
-- Null = tour will auto-start on the dashboard; settings can reset it to
-- replay the tour.
alter table users add column if not exists product_tour_completed_at timestamptz;
