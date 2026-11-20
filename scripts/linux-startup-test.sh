#!/usr/bin/env bash
# Test de démarrage sous Linux : lance Nel Code (l'AppImage, ou l'exécutable donné) dans une fenêtre virtuelle (xvfb),
# avec un dossier de données temporaire, et vérifie qu'il démarre (ligne « démarrage de Nel Code » dans le journal) et
# tourne encore 10 s plus tard. Usage : scripts/linux-startup-test.sh <exécutable ou AppImage>
set -euo pipefail
exe="$1"
home="$(mktemp -d)"
out="$home/sortie.txt"
export NELCODE_HOME="$home"
# Une AppImage sans FUSE (runners) : extraite puis lancée.
export APPIMAGE_EXTRACT_AND_RUN=1
chmod +x "$exe"
# Dans son propre groupe de processus (setsid) : la fin du test arrête xvfb, Nel Code et WebKit d'un coup. (Un
# « pkill -f "$exe" » tuait aussi ce script, dont la ligne de commande contient le même chemin : code 143.)
setsid xvfb-run -a "$exe" >"$out" 2>&1 &
pid=$!
trap 'kill -TERM -- -$pid 2>/dev/null || true' EXIT

for _ in $(seq 60); do
  if grep -qs "démarrage de Nel Code" "$home"/logs/*.log; then break; fi
  if ! kill -0 $pid 2>/dev/null; then echo "::error::Nel Code s'est arrêté au démarrage"; cat "$out"; exit 1; fi
  sleep 1
done
grep -qs "démarrage de Nel Code" "$home"/logs/*.log || { echo "::error::pas de démarrage dans le journal après 60 s"; cat "$out"; exit 1; }
sleep 10
kill -0 $pid 2>/dev/null || { echo "::error::Nel Code s'est arrêté après le démarrage"; cat "$out"; exit 1; }
if grep -q "panicked" "$out"; then echo "::error::panique au démarrage"; cat "$out"; exit 1; fi
echo "Nel Code démarre sous Linux :"
cat "$home"/logs/*.log
