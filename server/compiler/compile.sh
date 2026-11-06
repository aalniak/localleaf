# Runs inside the TeX Live container (piped to `bash -s`).
# Also run directly (no Docker) by the "texlive" backend, which sets
# LOCALLEAF_DATA_ROOT / LOCALLEAF_WORK_ROOT instead of the /data, /work defaults.
# Usage: compile.sh <project-id> <main-file> <engine> <draft:0|1> <fast:0|1>
#
# Strategy: sync the project into a container-local working copy (fast I/O),
# then
#   fast=1 (pdflatex/lualatex): let latexmk converge in -draftmode (no PDF
#           written, so passes are cheap) and finish with one full pass that
#           writes the PDF and SyncTeX data.
#   fast=0 / xelatex: a plain latexmk run.
# Outputs (pdf, log, synctex, blg) are copied back to /data/<id>/output.
set -u
ID="$1"; MAIN="$2"; ENGINE="$3"; DRAFT="$4"; FAST="$5"
DATA_ROOT="${LOCALLEAF_DATA_ROOT:-/data}"
WORK_ROOT="${LOCALLEAF_WORK_ROOT:-/work}"
SRC="$DATA_ROOT/$ID/files/"
WORK="$WORK_ROOT/$ID"
HOSTOUT="$DATA_ROOT/$ID/output"
JOB="$(basename "$MAIN")"; JOB="${JOB%.*}"

mkdir -p "$WORK/src" "$WORK/out" "$HOSTOUT"
if ! rsync -a --delete "$SRC" "$WORK/src/"; then
  echo "LOCALLEAF: failed to sync project files into the build directory" >&2
  exit 90
fi
cd "$WORK/src" || exit 90
# \include{sub/file} writes sub/file.aux, so the output dir must mirror folders.
find . -mindepth 1 -type d -exec mkdir -p "$WORK/out/{}" \;

case "$ENGINE" in
  pdflatex) MKFLAG=-pdf;      DRAFTCMD="pdflatex -draftmode %O %P" ;;
  lualatex) MKFLAG=-lualatex; DRAFTCMD="lualatex --draftmode %O %P" ;;
  xelatex)  MKFLAG=-xelatex;  DRAFTCMD=""; FAST=0 ;;
  *) echo "LOCALLEAF: unknown engine $ENGINE" >&2; exit 91 ;;
esac

PRETEX=""
if [ "$DRAFT" = "1" ]; then PRETEX='\PassOptionsToPackage{draft}{graphicx}'; fi
PRETEXOPT=()
if [ -n "$PRETEX" ]; then PRETEXOPT=("-usepretex=$PRETEX"); fi
COMMON=(-interaction=nonstopmode -file-line-error -synctex=1)

rm -f "$WORK/out/$JOB.pdf" "$WORK/out/$JOB.synctex.gz" "$WORK/out/$JOB.blg"

if [ "$FAST" = "1" ]; then
  echo "LOCALLEAF: converging with $ENGINE in draft mode"
  if [ "$ENGINE" = "pdflatex" ]; then
    latexmk -norc "$MKFLAG" -f -outdir="$WORK/out" "${PRETEXOPT[@]}" -pdflatex="$DRAFTCMD" "${COMMON[@]}" "$MAIN"
  else
    latexmk -norc "$MKFLAG" -f -outdir="$WORK/out" "${PRETEXOPT[@]}" -lualatex="$DRAFTCMD" "${COMMON[@]}" "$MAIN"
  fi
  echo "LOCALLEAF: final $ENGINE pass"
  if [ -n "$PRETEX" ]; then
    "$ENGINE" "${COMMON[@]}" -output-directory="$WORK/out" -jobname="$JOB" "$PRETEX\\input{$MAIN}"
  else
    "$ENGINE" "${COMMON[@]}" -output-directory="$WORK/out" "$MAIN"
  fi
else
  latexmk -norc "$MKFLAG" -f -outdir="$WORK/out" "${PRETEXOPT[@]}" "${COMMON[@]}" "$MAIN"
fi

for ext in log blg synctex.gz pdf; do
  if [ -f "$WORK/out/$JOB.$ext" ]; then
    cp -f "$WORK/out/$JOB.$ext" "$HOSTOUT/.$JOB.$ext.tmp" && mv -f "$HOSTOUT/.$JOB.$ext.tmp" "$HOSTOUT/$JOB.$ext"
  fi
done
echo "LOCALLEAF: done"
exit 0
