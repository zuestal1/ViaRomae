#!/usr/bin/env bash
# update.sh – Zieht den neuesten Code und deployed neu.
# Auf dem Ubuntu-Server ausführen: bash update.sh
set -Eeuo pipefail

PROJECT_DIR="/opt/jlw2026"
ENV_FILE=".env.production"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[UPDATE]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

cd "$PROJECT_DIR"

info "Aktueller Commit vor Update: $(git rev-parse --short HEAD)"
info "Branch: $(git rev-parse --abbrev-ref HEAD)"

# ── DB-Backup vor dem Update ──────────────────────────────────────────────────
info "Erstelle DB-Backup ..."
BACKUP_FILE="backups/pre-update_$(date +%Y%m%d_%H%M%S).sql"
mkdir -p backups
docker compose -f docker-compose.production.yml --env-file "$ENV_FILE" \
  exec -T postgres pg_dump \
  -U "$(grep POSTGRES_USER $ENV_FILE | cut -d= -f2)" \
  "$(grep POSTGRES_DB $ENV_FILE | cut -d= -f2)" \
  > "$BACKUP_FILE" 2>/dev/null && info "Backup: $BACKUP_FILE" || warn "Backup fehlgeschlagen – wird trotzdem fortgesetzt."

# ── Code holen ────────────────────────────────────────────────────────────────
info "git pull ..."
git pull

info "Neuer Commit: $(git rev-parse --short HEAD)"

# ── Deploy ────────────────────────────────────────────────────────────────────
info "Starte Deploy ..."
chmod +x deploy.sh
./deploy.sh production

info "════════════════════════════════════════"
info "Update erfolgreich abgeschlossen! 🎉"
info "════════════════════════════════════════"
info "Logs:   docker compose -f docker-compose.production.yml logs -f"
info "Status: docker compose -f docker-compose.production.yml ps"
