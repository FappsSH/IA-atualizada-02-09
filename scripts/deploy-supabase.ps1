param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:SUPABASE_PROJECT_ID) {
  throw "SUPABASE_PROJECT_ID não definido."
}

if (-not $env:SUPABASE_ACCESS_TOKEN) {
  throw "SUPABASE_ACCESS_TOKEN não definido."
}

$functions = @(
  "ai-processor",
  "webhook-receiver",
  "debounce-worker",
  "whatsapp-sender",
  "followup-worker"
)

Write-Host "Linkando projeto $($env:SUPABASE_PROJECT_ID)..."
npx.cmd supabase link --project-ref $env:SUPABASE_PROJECT_ID

Write-Host "Validando migrations..."
if ($DryRun) {
  npx.cmd supabase db push --dry-run
} else {
  npx.cmd supabase db push
}

foreach ($fn in $functions) {
  Write-Host "Deploy da function $fn..."
  npx.cmd supabase functions deploy $fn --no-verify-jwt
}

Write-Host "Concluído."
