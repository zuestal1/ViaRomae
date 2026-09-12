#!/bin/bash
###############################################################################
# ViaRomae - Complete Ubuntu Server Setup & Deployment
###############################################################################
# Dieses Script führt den KOMPLETTEN Setup durch:
# 1. System-Abhängigkeiten (Docker, Nginx, etc.)
# 2. Projekt-Setup (Clone oder Update)
# 3. Environment-Konfiguration (interaktiv)
# 4. Docker Deployment
# 5. Optionale Nginx + SSL Konfiguration
###############################################################################

set -e

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ─── Helper Functions ────────────────────────────────────────────────────────
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "\n${CYAN}═══ $1 ═══${NC}\n"; }

confirm() {
    read -p "$(echo -e "${YELLOW}$1 [y/N]:${NC} ")" -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]]
}

generate_password() {
    openssl rand -base64 32 | tr -d "=+/" | cut -c1-32
}

check_root() {
    if [ "$EUID" -eq 0 ]; then
        log_error "Bitte NICHT als root ausführen!"
        log_info "Das Script wird bei Bedarf nach sudo fragen."
        exit 1
    fi
}

# ─── Banner ──────────────────────────────────────────────────────────────────
clear
cat << "EOF"
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   VIA ROMAE - Ubuntu Server Setup & Deployment               ║
║   ──────────────────────────────────────────────             ║
║   Vollautomatische Installation für lokales Hosting          ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
EOF

echo ""
log_info "Dieses Script wird:"
echo "  1. Docker, Nginx, UFW, Fail2Ban installieren"
echo "  2. Projekt einrichten (Clone/Update)"
echo "  3. .env.production interaktiv konfigurieren"
echo "  4. Docker-Container starten (Backend, Frontend, GM, DB, MinIO)"
echo "  5. Optional: Nginx Reverse Proxy + SSL einrichten"
echo ""

check_root

if ! confirm "Möchtest du fortfahren?"; then
    log_info "Abgebrochen."
    exit 0
fi

# ─── Configuration ───────────────────────────────────────────────────────────
PROJECT_DIR="/opt/jlw2026"
REPO_URL=""  # Wird später abgefragt
SERVER_IP=$(hostname -I | awk '{print $1}')

log_step "SCHRITT 1: System-Abhängigkeiten installieren"

log_info "System-Update..."
sudo apt update && sudo apt upgrade -y

log_info "Installiere Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sudo sh /tmp/get-docker.sh
    sudo usermod -aG docker $USER
    log_info "✓ Docker installiert"
else
    log_info "✓ Docker bereits installiert"
fi

log_info "Installiere Docker Compose Plugin..."
sudo apt install -y docker-compose-plugin

log_info "Installiere Nginx..."
sudo apt install -y nginx

log_info "Installiere Tools..."
sudo apt install -y git curl wget htop ufw fail2ban certbot python3-certbot-nginx postgresql-client

log_info "Konfiguriere Firewall (UFW)..."
sudo ufw --force enable
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # HTTP
sudo ufw allow 443/tcp  # HTTPS
sudo ufw allow 3000/tcp # Backend (LAN)
sudo ufw allow 5173/tcp # Frontend (LAN)
sudo ufw allow 5174/tcp # GM Client (LAN)
sudo ufw allow 9000/tcp # MinIO (optional)
sudo ufw status

log_info "Konfiguriere Fail2Ban..."
sudo systemctl enable fail2ban
sudo systemctl start fail2ban

log_step "SCHRITT 2: Projekt einrichten"

if [ -d "$PROJECT_DIR/.git" ]; then
    log_info "Projekt existiert bereits in $PROJECT_DIR"
    
    if confirm "Möchtest du git pull ausführen?"; then
        cd "$PROJECT_DIR"
        git pull origin main || git pull origin master
        log_info "✓ Repository aktualisiert"
    fi
else
    log_info "Projekt wird neu geklont..."
    
    echo ""
    echo -e "${CYAN}Repository-URL eingeben:${NC}"
    read -p "Git URL (oder leer lassen zum Überspringen): " REPO_URL
    
    if [ -n "$REPO_URL" ]; then
        sudo mkdir -p "$PROJECT_DIR"
        sudo chown "$USER:$USER" "$PROJECT_DIR"
        git clone "$REPO_URL" "$PROJECT_DIR"
        log_info "✓ Repository geklont"
    else
        log_warn "Repository-Clone übersprungen"
        log_info "Bitte manuell Code nach $PROJECT_DIR kopieren!"
        
        if ! confirm "Code ist bereits in $PROJECT_DIR vorhanden?"; then
            log_error "Abbruch - Code fehlt"
            exit 1
        fi
    fi
fi

cd "$PROJECT_DIR"

log_step "SCHRITT 3: Environment-Konfiguration"

ENV_FILE=".env.production"

if [ -f "$ENV_FILE" ]; then
    log_warn "$ENV_FILE existiert bereits!"
    
    if confirm "Möchtest du sie überschreiben? (Backup wird erstellt)"; then
        cp "$ENV_FILE" "${ENV_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
        log_info "Backup erstellt"
    else
        log_info "Bestehende .env.production wird verwendet"
        
        log_step "SCHRITT 4: Docker Deployment"
        
        if confirm "Deployment jetzt starten?"; then
            chmod +x deploy.sh
            ./deploy.sh production
        else
            log_info "Deployment übersprungen"
            log_info "Manuell starten mit: ./deploy.sh production"
        fi
        
        exit 0
    fi
fi

log_info "Erstelle $ENV_FILE interaktiv..."
echo ""

# ── Datenbank ────────────────────────────────────────────────────────────────
log_info "━━━ Datenbank-Konfiguration ━━━"
DB_PASSWORD=$(generate_password)
log_info "Generiertes DB-Passwort: $DB_PASSWORD"

if confirm "Eigenes DB-Passwort setzen?"; then
    read -sp "DB-Passwort: " DB_PASSWORD
    echo
fi

# ── JWT Secret ───────────────────────────────────────────────────────────────
JWT_SECRET=$(generate_password)
log_info "✓ JWT Secret generiert"

# ── Server-IP ────────────────────────────────────────────────────────────────
log_info "━━━ Netzwerk-Konfiguration ━━━"
log_info "Erkannte Server-IP: $SERVER_IP"

if confirm "Andere IP/Domain verwenden?"; then
    read -p "Server IP oder Domain: " SERVER_IP
fi

# ── MapTiler ─────────────────────────────────────────────────────────────────
log_info "━━━ MapTiler API Key ━━━"
echo "Hole deinen Key von: https://www.maptiler.com/"
read -p "MapTiler API Key: " MAPTILER_KEY

# ── MinIO ────────────────────────────────────────────────────────────────────
log_info "━━━ MinIO (S3-Alternative) ━━━"
MINIO_PASSWORD=$(generate_password)
log_info "✓ MinIO-Passwort generiert"

# ── Production-Filter ────────────────────────────────────────────────────────
log_info "━━━ Release Preflight (Content-Prüfung) ━━━"
EXPECTED_PLAYERS=0
EXPECTED_TEAMS=0

echo "Das System prüft standardmäßig:"
echo "  - 40 Quests"
echo "  - 13 Spieler"
echo "  - 4 Teams"
echo ""
echo "Für lokale Tests ohne volles Event-Roster:"

read -p "Erwartete Spieleranzahl (0 = Check deaktiviert): " EXPECTED_PLAYERS
read -p "Erwartete Teamanzahl (0 = Check deaktiviert): " EXPECTED_TEAMS

# ── .env.production schreiben ────────────────────────────────────────────────
log_info "Schreibe $ENV_FILE..."

cat > "$ENV_FILE" << EOF
# ─── Database ────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://postgres:${DB_PASSWORD}@postgres:5432/jugendleiter2026
POSTGRES_USER=postgres
POSTGRES_PASSWORD=${DB_PASSWORD}
POSTGRES_DB=jugendleiter2026

# ─── Authentication ──────────────────────────────────────────────────────────
JWT_SECRET=${JWT_SECRET}

# ─── Backend API ─────────────────────────────────────────────────────────────
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info

# ─── Frontend / GM (muss bei Änderung neu gebaut werden) ────────────────────
VITE_API_BASE_URL=http://${SERVER_IP}:3000
VITE_MAPTILER_API_KEY=${MAPTILER_KEY}
VITE_GM_CLIENT_URL=http://${SERVER_IP}:5174
FRONTEND_ORIGIN=http://${SERVER_IP}:5173
GM_FRONTEND_ORIGIN=http://${SERVER_IP}:5174

# ─── Object Storage (MinIO) ──────────────────────────────────────────────────
S3_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=http://${SERVER_IP}:9000
S3_FORCE_PATH_STYLE=true
S3_BUCKET=via-romae-media
S3_REGION=eu-central-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=${MINIO_PASSWORD}
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=${MINIO_PASSWORD}

MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=${MINIO_PASSWORD}

# ─── Release Preflight ───────────────────────────────────────────────────────
EXPECTED_PLAYER_COUNT=${EXPECTED_PLAYERS}
EXPECTED_TEAM_COUNT=${EXPECTED_TEAMS}
EOF

chmod 600 "$ENV_FILE"
log_info "✓ $ENV_FILE erstellt (Permissions: 600)"

# ── Zusammenfassung ──────────────────────────────────────────────────────────
echo ""
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log_info "  KONFIGURATION ABGESCHLOSSEN"
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Frontend:   http://${SERVER_IP}:5173"
echo "  GM Client:  http://${SERVER_IP}:5174"
echo "  Backend:    http://${SERVER_IP}:3000"
echo "  Media API:  http://${SERVER_IP}:9000"
echo "  MinIO UI:   http://${SERVER_IP}:9001"
echo ""
echo "  DB User:    postgres"
echo "  DB Pass:    ${DB_PASSWORD}"
echo "  MinIO User: minioadmin"
echo "  MinIO Pass: ${MINIO_PASSWORD}"
echo ""
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

log_step "SCHRITT 4: Docker Deployment"

if ! confirm "Möchtest du das Deployment jetzt starten?"; then
    log_info "Deployment übersprungen"
    echo ""
    log_info "Manuell starten mit:"
    echo "  cd $PROJECT_DIR"
    echo "  ./deploy.sh production"
    exit 0
fi

# Backup-Verzeichnis erstellen
mkdir -p "$PROJECT_DIR/backups"

# Deploy-Script ausführbar machen
chmod +x deploy.sh

log_info "Starte Deployment..."
./deploy.sh production

log_step "SCHRITT 5 (Optional): Nginx Reverse Proxy"

echo ""
log_info "Aktuell sind die Dienste direkt über Ports erreichbar."
log_info "Mit Nginx kannst du:"
echo "  - HTTPS/SSL aktivieren (Let's Encrypt)"
echo "  - Schönere URLs (api.domain.com statt IP:3000)"
echo "  - Rate Limiting"
echo "  - Basic Auth für GM Client"
echo ""

if ! confirm "Möchtest du Nginx Reverse Proxy konfigurieren?"; then
    log_info "Nginx-Setup übersprungen"
    
    log_step "FERTIG!"
    
    cat << EOF

╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ✓ DEPLOYMENT ERFOLGREICH!                                  ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

Zugriff über LAN:

  Spieler-App:  http://${SERVER_IP}:5173
  GM Dashboard: http://${SERVER_IP}:5174
  Backend API:  http://${SERVER_IP}:3000/health

Nächste Schritte:

  1. Test-Accounts anlegen:
     docker compose -f docker-compose.production.yml exec backend pnpm run db:seed

  2. Logs ansehen:
     docker compose -f docker-compose.production.yml logs -f

  3. Health Check:
     curl http://${SERVER_IP}:3000/health

  4. Status prüfen:
     docker compose -f docker-compose.production.yml ps

WICHTIG für Handys im WLAN:
  - Firewall-Ports sind bereits offen (UFW)
  - Handys müssen im GLEICHEN Netzwerk sein
  - In der App die IP ${SERVER_IP} verwenden

EOF
    exit 0
fi

# ── Nginx Setup ──────────────────────────────────────────────────────────────
log_info "Nginx Reverse Proxy wird konfiguriert..."

echo ""
log_warn "Du brauchst eine Domain mit DNS-Einträgen:"
echo "  - jlw2026.deine-domain.de      → ${SERVER_IP}"
echo "  - api.jlw2026.deine-domain.de  → ${SERVER_IP}"
echo "  - gm.jlw2026.deine-domain.de   → ${SERVER_IP}"
echo ""

read -p "Domain (z.B. jlw2026.example.com): " DOMAIN

if [ -z "$DOMAIN" ]; then
    log_warn "Keine Domain eingegeben - Nginx-Setup übersprungen"
    exit 0
fi

# Nginx-Config aus Projekt kopieren
if [ -f "nginx/jlw2026.conf" ]; then
    log_info "Kopiere Nginx-Konfiguration..."
    
    # Domain in Config ersetzen
    sudo cp nginx/jlw2026.conf /etc/nginx/sites-available/jlw2026.conf
    sudo sed -i "s/jlw2026.example.com/${DOMAIN}/g" /etc/nginx/sites-available/jlw2026.conf
    sudo sed -i "s/api.jlw2026.example.com/api.${DOMAIN}/g" /etc/nginx/sites-available/jlw2026.conf
    sudo sed -i "s/gm.jlw2026.example.com/gm.${DOMAIN}/g" /etc/nginx/sites-available/jlw2026.conf
    
    # Symlink erstellen
    sudo ln -sf /etc/nginx/sites-available/jlw2026.conf /etc/nginx/sites-enabled/
    
    # Default-Site entfernen
    sudo rm -f /etc/nginx/sites-enabled/default
    
    # Nginx testen
    if sudo nginx -t; then
        sudo systemctl reload nginx
        log_info "✓ Nginx konfiguriert"
    else
        log_error "Nginx-Config ungültig!"
        exit 1
    fi
else
    log_warn "nginx/jlw2026.conf nicht gefunden - übersprungen"
fi

# ── SSL mit Certbot ──────────────────────────────────────────────────────────
echo ""
if confirm "Möchtest du jetzt SSL-Zertifikate erstellen (Let's Encrypt)?"; then
    log_info "Starte Certbot..."
    
    sudo certbot --nginx \
        -d "$DOMAIN" \
        -d "api.${DOMAIN}" \
        -d "gm.${DOMAIN}"
    
    log_info "✓ SSL-Zertifikate installiert"
    
    # .env.production aktualisieren
    sed -i "s|VITE_API_BASE_URL=.*|VITE_API_BASE_URL=https://api.${DOMAIN}|g" "$ENV_FILE"
    sed -i "s|VITE_GM_CLIENT_URL=.*|VITE_GM_CLIENT_URL=https://gm.${DOMAIN}|g" "$ENV_FILE"
    
    log_warn "WICHTIG: Frontend/GM müssen neu gebaut werden!"
    
    if confirm "Jetzt neu bauen und deployen?"; then
        ./deploy.sh production
    fi
fi

# ── Basic Auth für GM ────────────────────────────────────────────────────────
echo ""
if confirm "Möchtest du Basic Auth für das GM Dashboard aktivieren?"; then
    read -p "GM Username: " GM_USER
    
    sudo apt install -y apache2-utils
    sudo htpasswd -c /etc/nginx/.htpasswd "$GM_USER"
    sudo systemctl reload nginx
    
    log_info "✓ Basic Auth aktiviert"
fi

log_step "FERTIG!"

cat << EOF

╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ✓ KOMPLETTES SETUP ERFOLGREICH!                            ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

Zugriff:

  Spieler-App:  https://${DOMAIN}
  GM Dashboard: https://gm.${DOMAIN}
  Backend API:  https://api.${DOMAIN}/health

Befehle:

  Logs:         docker compose -f docker-compose.production.yml logs -f
  Status:       docker compose -f docker-compose.production.yml ps
  Restart:      docker compose -f docker-compose.production.yml restart
  Update:       cd $PROJECT_DIR && git pull && ./deploy.sh production
  Backup:       ./scripts/backup-db.sh

Automatisches Backup einrichten:

  crontab -e
  # Füge hinzu:
  0 2 * * * $PROJECT_DIR/scripts/backup-db.sh >> /var/log/jlw2026-backup.log 2>&1

EOF

# ── Docker-Gruppe Warnung ────────────────────────────────────────────────────
if groups $USER | grep -q docker; then
    log_info "✓ User ist in docker-Gruppe"
else
    log_warn "Du wurdest zur docker-Gruppe hinzugefügt!"
    log_warn "Bitte LOGOUT und neu einloggen, damit es wirksam wird!"
fi

exit 0
