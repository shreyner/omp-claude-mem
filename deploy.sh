#!/usr/bin/env bash
set -euo pipefail

workspace_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_file="$workspace_dir/src/claude-mem.ts"
upstream_file="$workspace_dir/upstream/claude-mem.ts"
state_file="$workspace_dir/.last-deployed.sha256"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
target_dir="$agent_dir/hooks/pre"
target_file="$target_dir/claude-mem.ts"
temporary_file=""

fail() { printf '%s\n' "$*" >&2; exit 1; }
hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
cleanup() { if [[ -n "$temporary_file" ]]; then rm -f -- "$temporary_file"; fi; }
trap cleanup EXIT

# Reject links throughout the destination path, including a dangling target link.
check_target_path() {
  local current="$target_file"
  while :; do
    [[ ! -L "$current" ]] || fail "Refusing symlink destination: $current"
    [[ "$current" != / ]] || break
    current="$(dirname -- "$current")"
  done
  [[ ! -e "$target_file" || -f "$target_file" ]] || fail "Destination is not a regular file: $target_file"
}

installed_hash() {
  if [[ -f "$target_file" ]]; then hash_file "$target_file"; else printf '%s\n' missing; fi
}

[[ "$agent_dir" = /* ]] || fail "PI_CODING_AGENT_DIR must be an absolute path"
[[ -f "$source_file" && ! -L "$source_file" ]] || fail "Source must be a regular file: $source_file"
[[ -f "$upstream_file" && ! -L "$upstream_file" ]] || fail "Upstream baseline must be a regular file: $upstream_file"
check_target_path
source_hash="$(hash_file "$source_file")"
# Every recorded upstream original (the first baseline and later ones under
# upstream/<version>/) is a known installed copy: the official installer writes it.
upstream_hashes=" "
for baseline in "$upstream_file" "$workspace_dir"/upstream/*/claude-mem.ts; do
  [[ -e "$baseline" || -L "$baseline" ]] || continue
  [[ -f "$baseline" && ! -L "$baseline" ]] || fail "Upstream baseline must be a regular file: $baseline"
  upstream_hashes+="$(hash_file "$baseline") "
done
previous_hash=""
if [[ -e "$state_file" || -L "$state_file" ]]; then
  [[ -f "$state_file" && ! -L "$state_file" ]] || fail "Invalid deployment state: $state_file"
  previous_hash="$(cat -- "$state_file")"
  [[ "$previous_hash" =~ ^[0-9a-f]{64}$ ]] || fail "Invalid checksum in $state_file"
fi
initial_hash="$(installed_hash)"
[[ "$initial_hash" = missing || "$upstream_hashes" == *" $initial_hash "* || "$initial_hash" = "$previous_hash" || "$initial_hash" = "$source_hash" ]] \
  || fail "Installed hook has unknown changes; inspect it before deployment: $target_file"

cd -- "$workspace_dir"
bun test tests

check_target_path
[[ "$(installed_hash)" = "$initial_hash" ]] || fail "Installed hook changed during checks; deployment stopped"
[[ "$(hash_file "$source_file")" = "$source_hash" ]] || fail "Source changed during checks; deployment stopped"
deployed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
backup_file=""
if [[ "$initial_hash" != "$source_hash" ]]; then
  mkdir -p -- "$workspace_dir/backups" "$target_dir"
  check_target_path
  if [[ "$initial_hash" != missing ]]; then
    backup_file="$(mktemp "$workspace_dir/backups/claude-mem-$(date -u '+%Y%m%dT%H%M%SZ')-${initial_hash:0:12}.XXXXXX")"
    cp -p -- "$target_file" "$backup_file"
    [[ "$(hash_file "$backup_file")" = "$initial_hash" ]] || fail "Backup checksum mismatch"
  fi
  temporary_file="$(mktemp "$target_dir/.claude-mem.ts.XXXXXX")"
  cp -p -- "$source_file" "$temporary_file"
  [[ "$(hash_file "$temporary_file")" = "$source_hash" ]] || fail "Staged hook checksum mismatch"
  check_target_path
  [[ "$(installed_hash)" = "$initial_hash" ]] || fail "Installed hook changed before replacement; deployment stopped"
  mv -f -- "$temporary_file" "$target_file"
  temporary_file=""
fi

[[ "$(hash_file "$target_file")" = "$source_hash" ]] || fail "Installed hook checksum mismatch"
printf '%s\n' "$source_hash" > "$state_file"
mkdir -p -- "$workspace_dir/reports"
printf 'deployed_at_utc=%s\nsha256=%s\ntarget=%s\nbackup=%s\n' \
  "$deployed_at" "$source_hash" "$target_file" "$backup_file" > "$workspace_dir/reports/deployment-latest.txt"
printf 'Installed SHA256 %s\nTarget: %s\n' "$source_hash" "$target_file"
if [[ -n "$backup_file" ]]; then printf 'Backup: %s\n' "$backup_file"; fi
printf '%s\n' 'Restart OMP when convenient; active sessions were not changed.'
