-- Phase 1 foundation sync
-- Aligns lead states with runtime behavior and follow-up lifecycle.

ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_etapa_atual_check;

ALTER TABLE leads
  ADD CONSTRAINT leads_etapa_atual_check
  CHECK (etapa_atual IN ('E1','E2','E3','E4','E5','E6','E7','encerrado','handoff','inativo'));
