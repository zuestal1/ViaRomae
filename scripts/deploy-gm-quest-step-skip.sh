#!/usr/bin/env bash
# Targeted production rollout for the GM quest-step-skip feature.
# Run from the repository root after the desired revision has been checked out.
set -Eeuo pipefail

env_file="${ENV_FILE:-.env.production}"
base_file="docker-compose.production.yml"

die() { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

[[ -f "$env_file" ]] || die "$env_file fehlt."
command -v docker >/dev/null || die "docker ist nicht installiert."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 ist nicht verfügbar."

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

compose=(docker compose --env-file "$env_file" -f "$base_file")
case "${STORAGE_PROVIDER:-local}" in
  minio) compose+=(-f docker-compose.production.minio.yml) ;;
  aws|local) ;;
  *) die "Unbekannter STORAGE_PROVIDER: ${STORAGE_PROVIDER:-}" ;;
esac

mkdir -p backups
backup="backups/pre-gm-step-skip-$(date -u +%Y%m%dT%H%M%SZ).sql"

info "Validiere die aufgelöste Compose-Konfiguration ..."
"${compose[@]}" config --quiet

info "Erstelle Datenbankbackup: $backup"
"${compose[@]}" exec -T postgres pg_dump \
  -U "${POSTGRES_USER:-postgres}" \
  "${POSTGRES_DB:-jugendleiter2026}" > "$backup"
[[ -s "$backup" ]] || die "Das Datenbankbackup ist leer. Deployment abgebrochen."

# backend and migrate intentionally use the same Dockerfile but have distinct
# Compose image names. Both must therefore be rebuilt. The player frontend did
# not change; only the GM client bundle needs rebuilding.
info "Baue Backend-, Migrations- und GM-Client-Images ..."
"${compose[@]}" build backend migrate gm-client

info "Wende Migration 0023 an ..."
"${compose[@]}" up --no-deps --force-recreate --abort-on-container-exit \
  --exit-code-from migrate migrate

info "Ersetze Backend und GM-Client ..."
"${compose[@]}" up -d --no-deps --force-recreate backend gm-client

info "Warte auf erfolgreiche Healthchecks ..."
for service in backend gm-client; do
  container_id="$("${compose[@]}" ps -q "$service")"
  [[ -n "$container_id" ]] || die "Kein Container für $service gefunden."
  for _ in $(seq 1 60); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
    [[ "$status" == "healthy" ]] && break
    [[ "$status" == "unhealthy" || "$status" == "exited" || "$status" == "dead" ]] && \
      die "$service ist $status. Logs: ${compose[*]} logs $service"
    sleep 2
  done
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
  [[ "$status" == "healthy" ]] || die "Timeout beim Healthcheck von $service (Status: $status)."
done

info "Prüfe angewandte Migration und Service-Status ..."
"${compose[@]}" exec -T postgres psql \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-jugendleiter2026}" -v ON_ERROR_STOP=1 -Atc \
  "SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='gm_command_type' AND e.enumlabel='QUEST_STEP_SKIP';" \
  | grep -qx 1 || die "QUEST_STEP_SKIP fehlt im Datenbank-Enum."
"${compose[@]}" ps backend gm-client migrate

info "Deployment erfolgreich. Backup: $backup"
