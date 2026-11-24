# Coloca a chave da OpenAI (do .env.local) na configuracao da AgentHub e roda o teste final de novo.
# A chave nunca e gravada no log.
$ErrorActionPreference = "Continue"
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $base "chave.log"
$proj = Join-Path $base "AgentHub"
"" | Out-File $log -Encoding utf8
function Log($t) { "[$(Get-Date -Format HH:mm:ss)] $t" | Out-File $log -Append -Encoding utf8 }
function Run($label, [scriptblock]$block) {
  Log "=== $label"
  & $block 2>&1 | ForEach-Object { "$_" } | Out-File $log -Append -Encoding utf8
  Log "exit=$LASTEXITCODE"
}
function Fail($t) { Log "CHAVE_FAILED: $t"; exit 1 }

Set-Location $proj
$zip = Join-Path $base "AgentHub-atualizado-2.zip"
if (Test-Path $zip) { Expand-Archive -Path $zip -DestinationPath $proj -Force; Log "codigo atualizado" }

$line = Get-Content "$proj\.env.local" | Where-Object { $_ -match '^\s*OPENAI_API_KEY\s*=' } | Select-Object -First 1
$key = if ($line) { ($line -replace '^\s*OPENAI_API_KEY\s*=\s*', '').Trim().Trim('"').Trim("'") } else { '' }
if (-not $key -or $key -like 'your-*') { Fail "OPENAI_API_KEY vazia no .env.local" }
Log ("chave encontrada no .env.local (comeca com " + $key.Substring(0, [Math]::Min(7, $key.Length)) + "..., " + $key.Length + " caracteres)")

try {
  $r = Invoke-WebRequest -Uri "https://api.openai.com/v1/models" -Headers @{ Authorization = "Bearer $key" } -UseBasicParsing -TimeoutSec 20
  Log "validacao na OpenAI: HTTP $($r.StatusCode)"
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Fail "a OpenAI recusou a chave (HTTP $code). Precisa de uma chave nova."
}

$db = docker ps --format "{{.Names}}" | Where-Object { $_ -like "supabase_db_*" } | Select-Object -First 1
$edge = docker ps -a --format "{{.Names}}" | Where-Object { $_ -like "supabase_edge_runtime_*" } | Select-Object -First 1
if (-not $db) { Fail "banco nao esta rodando" }
$sqlFile = Join-Path $base "sql\chave.sql"
New-Item -ItemType Directory -Force (Split-Path $sqlFile) | Out-Null
$safe = $key -replace "'", "''"
[System.IO.File]::WriteAllText($sqlFile, "UPDATE public.tenants SET config = coalesce(config,'{}'::jsonb) || jsonb_build_object('openai_api_key', '$safe') WHERE id = '00000000-0000-0000-0000-000000000001';")
docker cp $sqlFile "${db}:/tmp/chave.sql" | Out-Null
Remove-Item $sqlFile -Force -ErrorAction SilentlyContinue
Run "gravar chave na configuracao" { docker exec $db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -f /tmp/chave.sql }
docker exec $db rm -f /tmp/chave.sql | Out-Null

Run "reiniciar functions" { docker restart $edge }
Start-Sleep -Seconds 15

$sb = "$proj\node_modules\.bin\supabase.cmd"
$envOut = & $sb status -o env 2>&1 | ForEach-Object { "$_" }
$srk = ($envOut | Where-Object { $_ -match '^SERVICE_ROLE_KEY=' } | Select-Object -First 1) -replace '^SERVICE_ROLE_KEY=', '' -replace '"', ''
if ($srk) { $env:SUPABASE_SERVICE_ROLE_KEY = $srk }
$env:AGENTHUB_TEST_REPORT = Join-Path $base "resultado-teste.json"
Run "teste final E1-E7" { node --env-file=.env.local --experimental-strip-types scripts/test-agenthub-final.ts }
Run "logs das functions (erros)" { docker logs --since 30m $edge 2>&1 | Select-String -Pattern 'Error|erro' | Select-Object -Last 40 }
Log "CHAVE_DONE"
