-- Migration 009: optional venue / location field on tournaments
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS venue text;
