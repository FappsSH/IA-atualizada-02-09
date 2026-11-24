# Aplica as correcoes da AgentHub e roda o teste final. Tudo vai para aplicar.log.
# Nao mexe em navegador nem em outros projetos: so reinicia o container das functions da AgentHub.
$ErrorActionPreference = "Continue"
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $base "aplicar.log"
$proj = Join-Path $base "AgentHub"
"" | Out-File $log -Encoding utf8
function Log($t) { "[$(Get-Date -Format HH:mm:ss)] $t" | Out-File $log -Append -Encoding utf8 }
function Run($label, [scriptblock]$block) {
  Log "=== $label"
  & $block 2>&1 | ForEach-Object { "$_" } | Out-File $log -Append -Encoding utf8
  $code = $LASTEXITCODE
  Log "exit=$code"
  return $code
}
function Fail($t) { Log "APLICAR_FAILED: $t"; exit 1 }

# 1. Docker
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  docker info 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $ok = $true; break }
  if ($i -eq 0) { Log "Docker parado, abrindo..."; Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 6
}
if (-not $ok) { Fail "Docker nao ficou pronto" }

# 2. Codigo novo (o zip nao traz .env.local nem node_modules, que ficam como estao)
$zip = Join-Path $base "AgentHub-atualizado.zip"
if (-not (Test-Path $zip)) { Fail "AgentHub-atualizado.zip nao encontrado" }
Log "Atualizando codigo em $proj"
Expand-Archive -Path $zip -DestinationPath $proj -Force
Set-Location $proj
if (-not (Test-Path "$proj\.env.local")) { Copy-Item (Join-Path $base ".env.local") "$proj\.env.local" }
$sb = "$proj\node_modules\.bin\supabase.cmd"

$db = docker ps --format "{{.Names}}" | Where-Object { $_ -like "supabase_db_*" } | Select-Object -First 1
$edge = docker ps -a --format "{{.Names}}" | Where-Object { $_ -like "supabase_edge_runtime_*" } | Select-Object -First 1
if (-not $db) {
  Run "supabase start" { & $sb start -x vector --ignore-health-check } | Out-Null
  $db = docker ps --format "{{.Names}}" | Where-Object { $_ -like "supabase_db_*" } | Select-Object -First 1
  $edge = docker ps -a --format "{{.Names}}" | Where-Object { $_ -like "supabase_edge_runtime_*" } | Select-Object -First 1
}
if (-not $db) { Fail "banco do Supabase nao esta rodando" }
Log "db=$db edge=$edge"

function Sql($label, $file) {
  docker cp $file "${db}:/tmp/aplicar.sql" | Out-Null
  return (Run $label { docker exec $db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f /tmp/aplicar.sql })
}

# 3. Migracao nova (lista de nao atender)
if ((Sql "migracao lead_ignore_list" "$proj\supabase\migrations\20261124_lead_ignore_list.sql") -ne 0) { Fail "migracao falhou" }

# 4. Prompts (com backup automatico dos atuais em agent_definitions_backup)
if ((Sql "prompts PERSONALITY e E1-E7" "$proj\supabase\prompts\apply-prompts.sql") -ne 0) { Fail "prompts falharam" }

# 5. Lista de nao atender: todos os contatos que ja conversavam com o numero
$evo = docker ps --format "{{.Names}}" | Where-Object { $_ -match 'evolution' } | Select-Object -First 1
if ($evo) {
  $envList = (docker inspect $evo --format '{{json .Config.Env}}') | ConvertFrom-Json
  $key = ($envList | Where-Object { $_ -like 'AUTHENTICATION_API_KEY=*' } | Select-Object -First 1) -replace '^AUTHENTICATION_API_KEY=', ''
  $tenantRaw = docker exec $db psql -U postgres -d postgres -t -A -c "select coalesce(config->>'evolution_instance_name','') || '|' || coalesce(config->>'telefone_admin','') from tenants where id='00000000-0000-0000-0000-000000000001'"
  $parts = "$tenantRaw".Trim().Split('|')
  $inst = $parts[0]; $adminDigits = ($parts[1] -replace '\D', '')
  $h = @{ apikey = $key }
  $jids = New-Object System.Collections.Generic.List[string]
  $probe = @{}
  try {
    $contacts = Invoke-RestMethod -Uri "http://localhost:8080/chat/findContacts/$inst" -Headers $h -Method Post -ContentType "application/json" -Body '{}'
    $probe.contacts = @($contacts).Count
    if (@($contacts).Count -gt 0) { $probe.contact_fields = (@($contacts)[0].PSObject.Properties.Name -join ',') }
    foreach ($c in @($contacts)) { foreach ($v in @($c.remoteJid, $c.id)) { if ("$v" -match '@s\.whatsapp\.net$') { $jids.Add("$v") } } }
  } catch { Log "findContacts falhou: $($_.Exception.Message)" }
  try {
    $chats = Invoke-RestMethod -Uri "http://localhost:8080/chat/findChats/$inst" -Headers $h -Method Post -ContentType "application/json" -Body '{}'
    $probe.chats = @($chats).Count
    if (@($chats).Count -gt 0) { $probe.chat_fields = (@($chats)[0].PSObject.Properties.Name -join ',') }
    foreach ($c in @($chats)) { foreach ($v in @($c.remoteJid, $c.id, $c.remoteJidAlt)) { if ("$v" -match '@s\.whatsapp\.net$') { $jids.Add("$v") } } }
  } catch { Log "findChats falhou: $($_.Exception.Message)" }
  try {
    $sample = @($chats | Where-Object { "$($_.remoteJid)" -match '@s\.whatsapp\.net$' } | Select-Object -First 1)
    if ($sample.Count -gt 0) {
      $body = (@{ where = @{ key = @{ remoteJid = "$($sample[0].remoteJid)" } }; page = 1; offset = 5 } | ConvertTo-Json -Depth 5)
      $msgs = Invoke-RestMethod -Uri "http://localhost:8080/chat/findMessages/$inst" -Headers $h -Method Post -ContentType "application/json" -Body $body
      $probe.find_messages_shape = (($msgs | ConvertTo-Json -Depth 2 -Compress) -replace '"(conversation|text|caption|pushName|base64)":"[^"]*"', '"$1":"<oculto>"').Substring(0, [Math]::Min(400, ($msgs | ConvertTo-Json -Depth 2 -Compress).Length))
    }
  } catch { Log "findMessages falhou: $($_.Exception.Message)" }
  Log ("sonda evolution: " + ($probe | ConvertTo-Json -Compress))

  $leadPhones = docker exec $db psql -U postgres -d postgres -t -A -c "select regexp_replace(telefone,'\D','','g') from leads where tenant_id='00000000-0000-0000-0000-000000000001'"
  $leadSet = @{}; foreach ($p in $leadPhones) { if ($p) { $leadSet["$p".Trim()] = $true } }
  $rows = New-Object System.Collections.Generic.List[string]
  $seen = @{}
  foreach ($j in $jids) {
    $d = ($j -replace '@.*$', '') -replace '\D', ''
    if ($d.Length -eq 12 -and $d.StartsWith('55') -and '6789'.Contains($d.Substring(4,1))) { $d = $d.Substring(0,4) + '9' + $d.Substring(4) }
    if ($d.Length -lt 12 -or $seen.ContainsKey($d)) { continue }
    $seen[$d] = $true
    $short = if ($d.Length -eq 13) { $d.Substring(0,4) + $d.Substring(5) } else { $d }
    if ($d -eq $adminDigits -or $short -eq $adminDigits) { continue }
    if ($leadSet.ContainsKey($d) -or $leadSet.ContainsKey($short)) { continue }
    $rows.Add("00000000-0000-0000-0000-000000000001,$d,import_evolution")
  }
  $csv = Join-Path $base "sql\ignore.csv"
  New-Item -ItemType Directory -Force (Split-Path $csv) | Out-Null
  [System.IO.File]::WriteAllLines($csv, $rows)
  docker cp $csv "${db}:/tmp/ignore.csv" | Out-Null
  $imp = @"
CREATE TEMP TABLE imp (tenant_id uuid, telefone text, source text);
\copy imp FROM '/tmp/ignore.csv' WITH (FORMAT csv)
INSERT INTO public.lead_ignore_list (tenant_id, telefone, source) SELECT tenant_id, telefone, source FROM imp ON CONFLICT DO NOTHING;
SELECT count(*) AS total_nao_atender FROM public.lead_ignore_list;
"@
  $impFile = Join-Path $base "sql\ignore.sql"
  [System.IO.File]::WriteAllText($impFile, $imp)
  Sql "importar lista de nao atender ($($rows.Count) contatos)" $impFile | Out-Null
  Remove-Item $csv -ErrorAction SilentlyContinue
} else { Log "Evolution nao encontrada: lista de nao atender nao importada" }

# 6. Recarregar as functions
Run "reiniciar functions" { docker restart $edge } | Out-Null
Start-Sleep -Seconds 15
Run "teste webhook-receiver (GET deve dar 405)" { try { Invoke-WebRequest -Uri "http://127.0.0.1:54321/functions/v1/webhook-receiver" -UseBasicParsing } catch { "$($_.Exception.Response.StatusCode.value__)" } } | Out-Null

# 7. Teste final (tenant isolado + WhatsApp simulado)
$envOut = & $sb status -o env 2>&1 | ForEach-Object { "$_" }
$srk = ($envOut | Where-Object { $_ -match '^SERVICE_ROLE_KEY=' } | Select-Object -First 1) -replace '^SERVICE_ROLE_KEY=', '' -replace '"', ''
if ($srk) { $env:SUPABASE_SERVICE_ROLE_KEY = $srk }
$env:AGENTHUB_TEST_REPORT = Join-Path $base "resultado-teste.json"
Run "teste final E1-E7" { node --env-file=.env.local --experimental-strip-types scripts/test-agenthub-final.ts } | Out-Null
Run "logs das functions (ultimas linhas)" { docker logs --tail 60 $edge } | Out-Null
Log "APLICAR_DONE"
