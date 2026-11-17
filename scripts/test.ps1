# Lance cargo test --workspace puis les e2e ; n'affiche qu'un résumé et le détail des tests qui échouent.
# Usage : .\scripts\test.ps1 [-SansE2e] [-Fichier agent]   (-Fichier : un seul e2e/<nom>.test.mjs)
param([switch]$SansE2e, [string]$Fichier)
Set-Location (Split-Path $PSScriptRoot)
$ErrorActionPreference = 'Continue'
$echec = $false

function Compter($texte, $re) { ($texte | Select-String $re -AllMatches).Matches | ForEach-Object { [int]$_.Groups[1].Value } | Measure-Object -Sum | ForEach-Object { [int]$_.Sum } }

# --- cargo ---
$out = (cargo test --workspace -q 2>&1 | ForEach-Object { "$_" }) -join "`n"
$cargoCode = $LASTEXITCODE
$ok = Compter $out '(\d+) passed'; $ko = Compter $out '(\d+) failed'; $ig = Compter $out '(\d+) ignored'
"cargo : $ok réussis, $ko échecs, $ig ignorés"
if ($cargoCode -ne 0) {
    $echec = $true
    $i = $out.IndexOf("`nfailures:")
    if ($i -ge 0) { $out.Substring($i) } else { ($out -split "`n" | Select-Object -Last 40) -join "`n" }  # erreur de compilation
}

# --- e2e ---
if (-not $SansE2e) {
    cargo build -q -p nel-desktop 2>&1 | Out-Null
    $cible = if ($Fichier) { "e2e/$Fichier.test.mjs" } else { 'e2e/*.test.mjs' }
    $tap = (node --test --test-concurrency=1 --test-reporter=tap $cible 2>&1 | ForEach-Object { "$_" })
    $ok = Compter $tap '^# pass (\d+)'; $ko = Compter $tap '^# fail (\d+)'; $ig = Compter $tap '^# skipped (\d+)'
    "e2e   : $ok réussis, $ko échecs, $ig ignorés"
    if ($ko -gt 0 -or $LASTEXITCODE -ne 0) {
        $echec = $true
        $dans = $false
        foreach ($l in $tap) {
            if ($l -match '^\s*not ok') { $dans = $true; $l }
            elseif ($dans) { if ($l -match '^\s*\.\.\.') { $dans = $false } else { $l } }
        }
    }
}
exit ([int]$echec)
