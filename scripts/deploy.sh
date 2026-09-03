#!/usr/bin/env bash
# Deploy Fapps: core pipeline functions + utilitários.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${SUPABASE_PROJECT_ID:-}" ]]; then
    echo "❌ SUPABASE_PROJECT_ID não definido (export ou .env)"
    exit 1
fi

echo "▶ Linkando projeto $SUPABASE_PROJECT_ID"
npx supabase link --project-ref "$SUPABASE_PROJECT_ID" || true

echo "▶ db push dry-run"
npx supabase db push --dry-run

read -rp "Aplicar migrations? [y/N] " ans
if [[ "$ans" =~ ^[Yy]$ ]]; then
    npx supabase db push
fi

FNS=(ai-processor webhook-receiver debounce-worker whatsapp-sender followup-worker)
for fn in "${FNS[@]}"; do
    echo "▶ Deploy $fn"
    npx supabase functions deploy "$fn" --no-verify-jwt
done

echo "✅ Deploy concluído."
echo "   Webhook Evolution API → https://${SUPABASE_PROJECT_ID}.supabase.co/functions/v1/webhook-receiver"
