# Exporta Supabase local + Evolution API desta maquina para uma pasta de backup.
# Rodar NA MAQUINA ANTIGA, no PowerShell, dentro da pasta do projeto AgentHub:
#   powershell -ExecutionPolicy Bypass -File .\scripts\migracao\1-exportar-maquina-antiga.ps1
# Opcional: -Destino "D:\agenthub-backup"   -EvolutionFiltro "evolution"

param(
  [string]$Destino = "C:\agenthub-backup",
  [string]$SupabaseProjeto = "IA_Comercial_Vendas",
  [string]$EvolutionFiltro = "evolution"
)

$ErrorActionPreference = "Stop"
$proj = (Get-Location).Path
if (-not (Test-Path "$proj\supabase\config.toml")) {
  throw "Rode este script dentro da pasta do projeto AgentHub (onde existe supabase\config.toml)."
}

docker info *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker nao esta rodando. Abra o Docker Desktop e tente de novo." }

$volDir = Join-Path $Destino "volumes"
$cfgDir = Join-Path $Destino "config-files"
New-Item -ItemType Directory -Force $volDir, $cfgDir | Out-Null

Write-Host "`n[1/6] Inventario do que esta rodando..." -ForegroundColor Cyan
docker ps -a --format "{{.Names}}`t{{.Image}}`t{{.Status}}" | Out-File "$Destino\inventario-containers.txt" -Encoding utf8
docker volume ls -q | Out-File "$Destino\inventario-volumes.txt" -Encoding utf8
(npx.cmd supabase --version) | Out-File "$Destino\supabase-cli-version.txt" -Encoding utf8

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
  $p = docker inspect $c --format '{{ index .Config.Labels "com.docker.compose.project" }}'
  $d = docker inspect $c --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
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
npx.cmd supabase stop
foreach ($p in $evoProjetos) { docker compose -p $p stop }
foreach ($c in $evoContainers) { docker stop $c *> $null }

Write-Host "[5/6] Exportando volumes..." -ForegroundColor Cyan
$vols = @(docker volume ls -q | Where-Object { $_ -match [regex]::Escape($SupabaseProjeto) })
foreach ($p in $evoProjetos) {
  $vols += @(docker volume ls -q --filter "label=com.docker.compose.project=$p")
}
foreach ($c in $evoContainers) {
  $vols += @(docker inspect $c --format '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' | Where-Object { $_ })
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
