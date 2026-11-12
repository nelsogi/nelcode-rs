<#
.SYNOPSIS
  Crée le pack GPU de Nel Code : un zip avec uniquement les DLL CUDA dont Candle a besoin, prises dans le
  CUDA Toolkit, et l'avis de licence de NVIDIA.

.DESCRIPTION
  - La liste des DLL est celle de nel-engine/src/gpu.rs (PACK_DLLS) : une seule source.
  - Chaque DLL doit figurer dans la liste des fichiers redistribuables du CUDA EULA (Attachment A, Windows) :
    le nom est comparé sans son numéro de version (cublas64_12.dll -> cublas.dll), comme l'EULA l'autorise.
  - Le zip contient les DLL (à plat) et NVIDIA-LICENSE.txt (l'EULA du Toolkit), rien d'autre.
  - Écrit la taille et l'empreinte SHA-256 dans nel-desktop/src/gpu.rs (PACK_SHA256, PACK_BYTES, PACK_UNPACKED_BYTES).
  - -Publish : publie le zip dans la release « gpu-pack-cuda12 » (pre-release), sans jamais remplacer un pack déjà
    publié (les installations vérifient son empreinte).

.EXAMPLE
  .\make-gpu-pack.ps1
  .\make-gpu-pack.ps1 -CudaPath "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9" -Publish
#>
param(
  [string]$CudaPath = $(if ($env:CUDA_PATH) { $env:CUDA_PATH } else { "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9" }),
  [string]$OutDir = (Join-Path $PSScriptRoot "dist"),
  [switch]$Publish
)
$ErrorActionPreference = "Stop"

$Tag = "gpu-pack-cuda12"
$ZipName = "nelcode-gpu-pack-cuda12.zip"
$License = "NVIDIA-LICENSE.txt"
$EngineGpu = Join-Path $PSScriptRoot "nel-engine\src\gpu.rs"
$DesktopGpu = Join-Path $PSScriptRoot "nel-desktop\src\gpu.rs"

# --- Les DLL, depuis nel-engine/src/gpu.rs -------------------------------------------------------------------
$line = Select-String -Path $EngineGpu -Pattern 'pub const PACK_DLLS: \[&str; \d+\] = \[(.*)\];' | Select-Object -First 1
if (-not $line) { throw "PACK_DLLS introuvable dans $EngineGpu" }
$Dlls = [regex]::Matches($line.Matches[0].Groups[1].Value, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
Write-Host "DLL du pack : $($Dlls -join ', ')"

# --- Le Toolkit -----------------------------------------------------------------------------------------------
$Eula = Join-Path $CudaPath "EULA.txt"
if (-not (Test-Path $Eula)) { throw "EULA.txt introuvable : $CudaPath n'est pas un CUDA Toolkit" }
$Version = (Get-Content (Join-Path $CudaPath "version.json") -Raw | ConvertFrom-Json).cuda.version
if (-not $Version.StartsWith("12.")) { throw "CUDA $Version : le pack $Tag demande un CUDA Toolkit 12" }
Write-Host "CUDA Toolkit $Version : $CudaPath"

# --- Redistribuables : la liste Windows de l'Attachment A du CUDA EULA -------------------------------------------
$text = [System.IO.File]::ReadAllText($Eula, [System.Text.Encoding]::UTF8)
$start = $text.IndexOf("Attachment A", $text.IndexOf("2.6. Attachment A"))
if ($start -lt 0) { throw "Attachment A introuvable dans EULA.txt" }
$attachment = $text.Substring($start)
$end = $attachment.IndexOf("2.7.")
if ($end -gt 0) { $attachment = $attachment.Substring(0, $end) }
# Après chaque ligne « Windows » : la liste des fichiers, jusqu'à la ligne vide.
$redist = @()
$lines = $attachment -split "\r?\n"
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i].Trim() -ne "Windows") { continue }
  for ($j = $i + 1; $j -lt $lines.Count -and $lines[$j].Trim() -eq ""; $j++) {}
  for (; $j -lt $lines.Count -and $lines[$j].Trim() -ne ""; $j++) {
    $redist += ($lines[$j] -split ",") | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }
  }
}
if ($redist.Count -lt 5) { throw "liste des redistribuables illisible dans EULA.txt" }

foreach ($dll in $Dlls) {
  # cublasLt64_12.dll -> cublaslt.dll ; curand64_10.dll -> curand.dll (variantes de version autorisées par l'EULA)
  $base = ($dll.ToLower() -replace '(64)?(_\d+)+\.dll$', '.dll')
  if ($redist -notcontains $base) { throw "$dll ($base) n'est pas dans la liste des redistribuables du CUDA EULA" }
  Write-Host ("  {0,-20} redistribuable ({1})" -f $dll, $base)
}

# --- Le zip -----------------------------------------------------------------------------------------------------
$stage = Join-Path $OutDir "gpu-pack"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
foreach ($dll in $Dlls) {
  $src = Join-Path $CudaPath "bin\$dll"
  if (-not (Test-Path $src)) { throw "$src introuvable" }
  Copy-Item $src $stage
}
$notice = @"
Ce pack contient des bibliothèques du NVIDIA CUDA Toolkit $Version, redistribuées sans modification avec Nel Code
selon le contrat de licence ci-dessous (CUDA Toolkit EULA, « Attachment A » : fichiers redistribuables) :
$($Dlls -join ', ')

Copyright NVIDIA Corporation. Tous droits réservés.

"@
Set-Content -Path (Join-Path $stage $License) -Value ($notice + $text) -Encoding UTF8

$zip = Join-Path $OutDir $ZipName
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
$unpacked = (Get-ChildItem $stage | Measure-Object Length -Sum).Sum
$bytes = (Get-Item $zip).Length
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Remove-Item $stage -Recurse -Force
Write-Host ""
Write-Host "Pack      : $zip"
Write-Host ("Taille    : {0:N1} Mo (extrait : {1:N1} Mo)" -f ($bytes / 1MB), ($unpacked / 1MB))
Write-Host "SHA-256   : $sha"

# --- Dans le code de l'application ----------------------------------------------------------------------------
$code = [System.IO.File]::ReadAllText($DesktopGpu, [System.Text.Encoding]::UTF8)   # Get-Content (PS 5.1) lirait de l'ANSI
$code = $code -replace 'pub const PACK_SHA256: &str = "[0-9a-f]*";', "pub const PACK_SHA256: &str = `"$sha`";"
$code = $code -replace 'pub const PACK_BYTES: u64 = [\d_]+;', "pub const PACK_BYTES: u64 = $bytes;"
$code = $code -replace 'pub const PACK_UNPACKED_BYTES: u64 = [\d_]+;', "pub const PACK_UNPACKED_BYTES: u64 = $unpacked;"
[System.IO.File]::WriteAllText($DesktopGpu, $code, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Écrit dans nel-desktop/src/gpu.rs."

# --- Publication ------------------------------------------------------------------------------------------------
if ($Publish) {
  gh release view $Tag *> $null
  if ($LASTEXITCODE -ne 0) {
    gh release create $Tag --prerelease --title "Pack GPU (CUDA 12)" --notes "Les bibliothèques CUDA de NVIDIA pour le calcul sur GPU dans Nel Code (Réglages > Calcul > « Installer le pack GPU »). CUDA Toolkit $Version, redistribuées selon le CUDA EULA (avis dans $License). SHA-256 : $sha"
    if ($LASTEXITCODE -ne 0) { throw "création de la release $Tag impossible" }
  }
  $assets = gh release view $Tag --json assets -q ".assets[].name"
  if ($assets -contains $ZipName) { throw "$ZipName est déjà publié dans $Tag : les installations vérifient son empreinte, il ne doit pas changer" }
  gh release upload $Tag $zip
  if ($LASTEXITCODE -ne 0) { throw "envoi du pack impossible" }
  Write-Host "Publié : https://github.com/nelsogi/nelcode-rs/releases/download/$Tag/$ZipName"
}
