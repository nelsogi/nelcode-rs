#!/usr/bin/env bash
# latest.json (mises à jour automatiques) pour les trois systèmes, d'après les artefacts signés de la release <tag> :
# l'installateur NSIS (Windows), l'AppImage (Linux ; le .deb se met à jour à la main) et le .app.tar.gz universel
# (macOS, Intel et Apple Silicon). Usage : scripts/updater-json.sh <tag> <fichier des notes> > latest.json
# (gh et jq ; GH_TOKEN et GITHUB_REPOSITORY dans l'environnement.)
# Avec UPDATER_DIR=<dossier>, les artefacts et leurs .sig sont pris dans ce dossier au lieu de la release (test du
# script, déclenchement manuel du workflow) : rien n'est lu ni écrit sur GitHub.
set -euo pipefail
tag="$1"
notes="$2"
if [ -n "${UPDATER_DIR:-}" ]; then
  dir="$UPDATER_DIR"
  assets="$(ls -1 "$dir")"
else
  dir="$(mktemp -d)"
  gh release download "$tag" --pattern '*.sig' --dir "$dir"
  assets="$(gh release view "$tag" --json assets -q '.assets[].name')"
fi

entry() {
  local name
  name="$(grep -E "$1" <<<"$assets" | grep -v '\.sig$' | head -n1 || true)"
  if [ -z "$name" ] || [ ! -f "$dir/$name.sig" ]; then
    echo "::error::artefact signé introuvable dans la release : $2 ($1)" >&2
    exit 1
  fi
  jq -n --arg sig "$(cat "$dir/$name.sig")" --arg url "https://github.com/$GITHUB_REPOSITORY/releases/download/$tag/$name" '{ signature: $sig, url: $url }'
}

win="$(entry '_x64-setup\.exe$' 'Windows')"
linux="$(entry '\.AppImage$' 'Linux')"
mac="$(entry '\.app\.tar\.gz$' 'macOS')"

jq -n --arg version "${tag#v}" --rawfile notes "$notes" --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson win "$win" --argjson linux "$linux" --argjson mac "$mac" '{
    version: $version, notes: $notes, pub_date: $date,
    platforms: {
      "windows-x86_64": $win, "windows-x86_64-nsis": $win,
      "linux-x86_64": $linux, "linux-x86_64-appimage": $linux,
      "darwin-x86_64": $mac, "darwin-x86_64-app": $mac,
      "darwin-aarch64": $mac, "darwin-aarch64-app": $mac
    }
  }'
