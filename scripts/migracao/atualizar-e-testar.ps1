# Atualiza a AgentHub com o pacote mais recente (AgentHub-atualizado*.zip), reaplica os prompts,
# reinicia so as functions da AgentHub e roda o teste final. Log em atualizar.log.
$ErrorActionPreference = "Continue"
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $base "atualizar.log"
$proj = Join-Path $base "AgentHub"
"" | Out-File $log -Encoding utf8
function Log($t) { "[$(Get-Date -Format HH:mm:ss)] $t" | Out-File $log -Append -Encoding utf8 }
function Run($label, [scriptblock]$block) {
  Log "=== $label"
  & $block 2>&1 | ForEach-Object { "$_" } | Out-File $log -Append -Encoding utf8
  Log "exit=$LASTEXITCODE"
}
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  docker info 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  if ($i -eq 0) { Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 6
}
if (-not $ok) { Log "ATUALIZAR_FAILED: docker"; exit 1 }

$zip = Get-ChildItem $base -Filter "AgentHub-atualizado*.zip" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Log "pacote: $($zip.Name)"
Expand-Archive -Path $zip.FullName -DestinationPath $proj -Force
Set-Location $proj

$db = docker ps --format "{{.Names}}" | Where-Object { $_ -like "supabase_db_*" } | Select-Object -First 1
$edge = docker ps -a --format "{{.Names}}" | Where-Object { $_ -like "supabase_edge_runtime_*" } | Select-Object -First 1
docker cp "$proj\supabase\prompts\apply-prompts.sql" "${db}:/tmp/aplicar.sql" | Out-Null
Run "prompts" { docker exec $db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -f /tmp/aplicar.sql }
Run "reiniciar functions" { docker restart $edge }
Start-Sleep -Seconds 15

$sb = "$proj\node_modules\.bin\supabase.cmd"
$envOut = & $sb status -o env 2>&1 | ForEach-Object { "$_" }
$srk = ($envOut | Where-Object { $_ -match '^SERVICE_ROLE_KEY=' } | Select-Object -First 1) -replace '^SERVICE_ROLE_KEY=', '' -replace '"', ''
if ($srk) { $env:SUPABASE_SERVICE_ROLE_KEY = $srk }
$env:AGENTHUB_TEST_REPORT = Join-Path $base "resultado-teste.json"
$started = Get-Date
Run "teste final E1-E7" { node --env-file=.env.local --experimental-strip-types scripts/test-agenthub-final.ts }
$mins = [Math]::Ceiling(((Get-Date) - $started).TotalMinutes) + 1
Run "erros das functions durante o teste" { docker logs --since "$($mins)m" $edge 2>&1 | Select-String -Pattern '\[Error\]|erro:' | Select-Object -Last 40 }
Log "ATUALIZAR_DONE"
