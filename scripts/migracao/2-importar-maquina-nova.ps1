# Importa o backup gerado pelo script 1 nesta maquina (nova).
# Rodar NA MAQUINA NOVA, no PowerShell, dentro da pasta do projeto AgentHub ja clonado:
#   powershell -ExecutionPolicy Bypass -File .\scripts\migracao\2-importar-maquina-nova.ps1
# Opcional: -Origem "D:\agenthub-backup"

param(
  [string]$Origem = "C:\agenthub-backup"
)

$ErrorActionPreference = "Stop"
$proj = (Get-Location).Path
if (-not (Test-Path "$proj\supabase\config.toml")) {
  throw "Rode este script dentro da pasta do projeto AgentHub (onde existe supabase\config.toml)."
}
if (-not (Test-Path "$Origem\volumes")) { throw "Nao achei $Origem\volumes. Copie a pasta de backup para ca primeiro." }

docker info *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker nao esta rodando. Abra o Docker Desktop e tente de novo." }

Write-Host "`n[1/5] Restaurando arquivos de configuracao..." -ForegroundColor Cyan
$cfgDir = Join-Path $Origem "config-files"
if (Test-Path $cfgDir) {
  foreach ($f in Get-ChildItem $cfgDir -File -Force) {
    $rel = $f.Name -replace '__', '\'
    $alvo = Join-Path $proj $rel
    if (Test-Path $alvo) {
      Write-Warning "$rel ja existe aqui. Mantive o atual (o do backup esta em $($f.FullName))."
    } else {
      Copy-Item $f.FullName $alvo
      Write-Host "   restaurado: $rel"
    }
  }
}

Write-Host "[2/5] Instalando dependencias do projeto..." -ForegroundColor Cyan
npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm ci falhou." }

Write-Host "[3/5] Restaurando volumes..." -ForegroundColor Cyan
$volDir = Join-Path $Origem "volumes"
$pulados = @()
foreach ($t in Get-ChildItem $volDir -Filter *.tgz) {
  $v = $t.Name -replace '\.tgz$', ''
  $existe = docker volume ls -q --filter "name=^${v}$"
  if ($existe) {
    Write-Warning "Volume $v ja existe nesta maquina. NAO sobrescrevi."
    $pulados += $v
    continue
  }
  $labelArgs = @()
  $lf = Join-Path $volDir "$v.labels.json"
  if (Test-Path $lf) {
    $raw = (Get-Content $lf -Raw).Trim()
    if ($raw -and $raw -ne "null") {
      $obj = $raw | ConvertFrom-Json
      foreach ($prop in $obj.PSObject.Properties) { $labelArgs += @("--label", "$($prop.Name)=$($prop.Value)") }
    }
  }
  docker volume create @labelArgs $v | Out-Null
  docker run --rm -v "${v}:/data" -v "${volDir}:/backup:ro" alpine tar xzf "/backup/$($t.Name)" -C /data
  if ($LASTEXITCODE -ne 0) { throw "Falha ao restaurar o volume $v" }
  Write-Host "   $v"
}

Write-Host "[4/5] Subindo Supabase local..." -ForegroundColor Cyan
npx.cmd supabase start
if ($LASTEXITCODE -ne 0) { throw "supabase start falhou. Me mande a saida." }

Write-Host "[5/5] Subindo Evolution API..." -ForegroundColor Cyan
$evoPastas = @(Get-ChildItem $Origem -Directory | Where-Object { $_.Name -like "evolution-compose*" })
if ($evoPastas.Count -eq 0) {
  Write-Warning "Nenhuma pasta evolution-compose no backup. Suba a Evolution manualmente."
}
foreach ($d in $evoPastas) {
  $destinoEvo = Join-Path $env:USERPROFILE "agenthub-$($d.Name)"
  if (-not (Test-Path $destinoEvo)) { Copy-Item $d.FullName $destinoEvo -Recurse }
  $nomeArq = Join-Path $destinoEvo ".compose-project-name"
  $nome = if (Test-Path $nomeArq) { (Get-Content $nomeArq -Raw).Trim() } else { "" }
  if (-not $nome) { Write-Warning "Nome do projeto compose desconhecido. Suba a Evolution manualmente em $destinoEvo."; continue }
  $jaExiste = docker ps -a -q --filter "label=com.docker.compose.project=$nome"
  if ($jaExiste) {
    Write-Warning "Ja existe uma stack '$nome' nesta maquina. NAO subi a Evolution do backup para nao conflitar. Me avise."
    continue
  }
  Push-Location $destinoEvo
  docker compose -p $nome up -d
  Pop-Location
  Write-Host "   Evolution ($nome) subiu a partir de $destinoEvo"
}

Write-Host "`nVerificacao:" -ForegroundColor Cyan
npx.cmd supabase status
docker ps --format "table {{.Names}}`t{{.Status}}`t{{.Ports}}"
if ($pulados.Count) { Write-Warning "Volumes que ja existiam e foram mantidos: $($pulados -join ', ')" }
Write-Host "`nPronto. Agora conecte a pasta do projeto no app do Claude (+ > Add folder)." -ForegroundColor Green
