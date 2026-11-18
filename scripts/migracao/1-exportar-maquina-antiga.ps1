# Exporta Supabase local + Evolution API desta maquina para uma pasta de backup.
# Rodar NA MAQUINA ANTIGA, no PowerShell, dentro da pasta do projeto AgentHub:
#   powershell -ExecutionPolicy Bypass -File .\scripts\migracao\1-exportar-maquina-antiga.ps1
# Opcional: -Destino "D:\agenthub-backup"   -EvolutionFiltro "evolution"

param(
  [string]$Destino = "C:\agenthub-backup",
  [string]$SupabaseProjeto = "",
  [string]$EvolutionFiltro = "evolution"
)

# Continue: no PowerShell 5.1, avisos que o docker/npx escrevem no stderr nao podem derrubar o script.
# Erros reais sao checados por $LASTEXITCODE e throw.
$ErrorActionPreference = "Continue"
$proj = (Get-Location).Path
if (-not (Test-Path "$proj\supabase\config.toml")) {
  throw "Rode este script dentro da pasta do projeto AgentHub (onde existe supabase\config.toml)."
}

if (-not $SupabaseProjeto) {
  $m = Select-String -Path "$proj\supabase\config.toml" -Pattern '^\s*project_id\s*=\s*"([^"]+)"' | Select-Object -First 1
  if ($m) { $SupabaseProjeto = $m.Matches[0].Groups[1].Value }
}
Write-Host "Projeto Supabase: $SupabaseProjeto"
if (-not (Test-Path "$proj\node_modules\.bin\supabase.cmd")) {
  Write-Warning "Esta pasta nao tem node_modules. Rode o script na pasta ORIGINAL do projeto (a que voce usava no dia a dia)."
  throw "node_modules ausente: o npx baixaria outra versao do Supabase CLI."
}

docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Docker nao esta rodando. Abra o Docker Desktop e tente de novo." }

$volDir = Join-Path $Destino "volumes"
$cfgDir = Join-Path $Destino "config-files"
New-Item -ItemType Directory -Force $volDir, $cfgDir | Out-Null

Write-Host "`n[1/6] Inventario do que esta rodando..." -ForegroundColor Cyan
docker ps -a --format "{{.Names}}`t{{.Image}}`t{{.Status}}" | Out-File "$Destino\inventario-containers.txt" -Encoding utf8
docker volume ls -q | Out-File "$Destino\inventario-volumes.txt" -Encoding utf8
(& "$proj\node_modules\.bin\supabase.cmd" --version) | Out-File "$Destino\supabase-cli-version.txt" -Encoding utf8

Write-Host "[2/6] Copiando arquivos de configuracao que nao vao pelo Git..." -ForegroundColor Cyan
foreach ($f in @(".env.local", ".env", "supabase\functions\.env", "supabase\.env")) {
  $p = Join-Path $proj $f
  if (Test-Path $p) {
    Copy-Item $p (Join-Path $cfgDir ($f -replace '\\', '__'))
    Write-Host "   copiado: $f"
  }
}

Write-Host "[3/6] Localizando a stack da Evolution API..." -ForegroundColor Cyan
$evoContainers = @(docker ps -a --format "{{.Names}}" | Where-Object { $_ -match $EvolutionFiltro })
$evoProjetos = @()
$evoPastas = @()
foreach ($c in $evoContainers) {
  $labels = (docker inspect $c --format '{{json .Config.Labels}}') | ConvertFrom-Json
  $p = if ($labels) { $labels.'com.docker.compose.project' } else { $null }
  $d = if ($labels) { $labels.'com.docker.compose.project.working_dir' } else { $null }
  if ($p) { $evoProjetos += $p }
  if ($d) { $evoPastas += $d }
}
$evoProjetos = @($evoProjetos | Sort-Object -Unique)
$evoPastas = @($evoPastas | Sort-Object -Unique)
if ($evoContainers.Count -eq 0) {
  Write-Warning "Nenhum container com '$EvolutionFiltro' no nome. A Evolution NAO sera exportada."
} else {
  Write-Host "   containers: $($evoContainers -join ', ')"
  Write-Host "   projeto compose: $($evoProjetos -join ', ')"
  Write-Host "   pasta compose: $($evoPastas -join ', ')"
}
$i = 0
foreach ($d in $evoPastas) {
  if (Test-Path $d) {
    $alvo = Join-Path $Destino ("evolution-compose" + $(if ($i) { "-$i" } else { "" }))
    Copy-Item $d $alvo -Recurse -Force
    $evoProjetos | Select-Object -First 1 | Out-File (Join-Path $alvo ".compose-project-name") -Encoding ascii
    Write-Host "   pasta copiada para $alvo"
    $i++
  }
}

Write-Host "[4/6] Parando Supabase e Evolution (os dados ficam guardados)..." -ForegroundColor Cyan
& "$proj\node_modules\.bin\supabase.cmd" stop
foreach ($p in $evoProjetos) { docker compose -p $p stop }
foreach ($c in $evoContainers) { docker stop $c *> $null }

Write-Host "[5/6] Exportando volumes..." -ForegroundColor Cyan
$vols = @(docker volume ls -q | Where-Object { $_ -match [regex]::Escape($SupabaseProjeto) })
foreach ($p in $evoProjetos) {
  $vols += @(docker volume ls -q --filter "label=com.docker.compose.project=$p")
}
foreach ($c in $evoContainers) {
  $mounts = (docker inspect $c --format '{{json .Mounts}}') | ConvertFrom-Json
  $vols += @($mounts | Where-Object { $_.Type -eq 'volume' } | ForEach-Object { $_.Name })
  $binds = @($mounts | Where-Object { $_.Type -eq 'bind' } | ForEach-Object { $_.Source })
  if ($binds.Count) { Write-Warning "Container $c usa pastas locais (bind): $($binds -join ', '). Copie-as junto com o backup." }
}
$vols = @($vols | Sort-Object -Unique)
if ($vols.Count -eq 0) { throw "Nenhum volume encontrado. Me mande o arquivo inventario-volumes.txt." }

foreach ($v in $vols) {
  Write-Host "   $v"
  docker volume inspect $v --format '{{json .Labels}}' | Out-File (Join-Path $volDir "$v.labels.json") -Encoding ascii
  docker run --rm -v "${v}:/data:ro" -v "${volDir}:/backup" alpine tar czf "/backup/$v.tgz" -C /data .
  if ($LASTEXITCODE -ne 0) { throw "Falha ao exportar o volume $v" }
}

Write-Host "[6/6] Resumo" -ForegroundColor Cyan
Get-ChildItem $volDir -Filter *.tgz | Select-Object Name, @{n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
Write-Host "Backup completo em: $Destino" -ForegroundColor Green
Write-Host "Copie a pasta inteira para a maquina nova (pendrive, rede ou nuvem)."
Write-Host "IMPORTANTE: nao suba de novo o Supabase/Evolution nesta maquina depois da migracao." -ForegroundColor Yellow
