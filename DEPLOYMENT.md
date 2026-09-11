# 🚀 Deployment Guide – Ubuntu Server

Vollständige Anleitung zum Deployment des JLW 2026 Projekts (Epic 1-9) auf einem Ubuntu Server.

---

## Verbindlicher Release-Preflight

Das Produktions-Compose importiert nach den Migrationen den freigegebenen
GeoJSON-/Questkatalog idempotent. `deploy.sh` bricht anschließend bewusst ab,
wenn Event-Roster oder Content unvollständig sind. Standardmäßig werden 13
Spieler in 4 Teams, mindestens ein GM-/Admin-Konto und genau 40 Quests mit
Schritten und Stationen erwartet.

Abweichende, ausdrücklich freigegebene Rostergrößen werden in
`.env.production` mit `EXPECTED_PLAYER_COUNT` und `EXPECTED_TEAM_COUNT`
konfiguriert. Vor dem Deployment müssen alle persönlichen Accounts und
Teamzuweisungen über das GM-Interface oder einen kontrollierten Rosterimport
angelegt sein. Der Preflight gibt keine Zugangscodes aus.

```bash
docker compose -f docker-compose.production.yml --env-file .env.production run --rm backend pnpm run release:preflight
```

Ein fehlgeschlagener Preflight ist ein harter Release-Blocker; das Event darf
in diesem Zustand nicht gestartet werden.

---

## 📋 Voraussetzungen

### Server Requirements
- **OS**: Ubuntu 22.04 LTS oder höher
- **RAM**: Mindestens 4GB (empfohlen: 8GB)
- **CPU**: 2+ Cores
- **Disk**: Mindestens 20GB freier Speicher
- **SSH**: Root- oder sudo-Zugriff
- **Domain**: Optional, für SSL/TLS (z.B. `jlw2026.example.com`)

### Software auf dem Server
- Docker (25.0+)
- Docker Compose (v2.0+)
- Nginx (für Reverse Proxy)
- Git
- Optional: Certbot (für Let's Encrypt SSL)

---

## 🛠️ Installation

### 1. Server vorbereiten

```bash
# System updaten
sudo apt update && sudo apt upgrade -y

# Docker installieren
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# Docker Compose installieren (v2)
sudo apt install docker-compose-plugin -y

# Nginx installieren
sudo apt install nginx -y

# Git installieren
sudo apt install git -y

# Firewall konfigurieren
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # HTTP
sudo ufw allow 443/tcp  # HTTPS
sudo ufw enable
```

### 2. Projekt auf Server klonen

```bash
# Arbeitsverzeichnis erstellen
mkdir -p /opt/jlw2026
cd /opt/jlw2026

# Repository klonen
git clone <your-repo-url> .
# ODER per SSH:
# git clone git@github.com:user/repo.git .

# Zum richtigen Branch wechseln
git checkout main  # oder production branch
```

### 3. Environment Variables konfigurieren

```bash
# Production .env erstellen
cp .env.example .env.production

# Environment-Datei editieren
nano .env.production
```

**Wichtige Variablen anpassen:**

```bash
# ─── Database ────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://postgres:SECURE_PASSWORD@postgres:5432/jugendleiter2026

# ─── Auth ────────────────────────────────────────────────────────────────────
JWT_SECRET=<GENERIERE EINEN SICHEREN KEY MIT 32+ ZEICHEN>

# ─── S3 / Object Storage ─────────────────────────────────────────────────────
S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com
S3_BUCKET=jlw2026-media-production
S3_ACCESS_KEY=<YOUR_AWS_ACCESS_KEY>
S3_SECRET_KEY=<YOUR_AWS_SECRET_KEY>
S3_REGION=eu-central-1

# ─── Backend ─────────────────────────────────────────────────────────────────
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info

# ─── Frontend URLs ───────────────────────────────────────────────────────────
VITE_API_BASE_URL=https://api.jlw2026.example.com
VITE_MAPTILER_API_KEY=<YOUR_MAPTILER_KEY>
```

**JWT Secret generieren:**
```bash
openssl rand -base64 32
```

### 4. S3 Bucket einrichten

#### Option A: AWS S3

```bash
# AWS CLI installieren
sudo apt install awscli -y

# AWS konfigurieren
aws configure

# S3 Bucket erstellen
aws s3 mb s3://jlw2026-media-production --region eu-central-1

# CORS für direkten Upload konfigurieren
cat > cors.json << 'EOF'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://jlw2026.example.com", "https://gm.jlw2026.example.com"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 3600
    }
  ]
}
EOF

aws s3api put-bucket-cors --bucket jlw2026-media-production --cors-configuration file://cors.json
```

#### Option B: MinIO (Self-Hosted S3-kompatibel)

```bash
# MinIO Container in docker-compose.yml bereits enthalten
# Siehe Abschnitt "Docker Compose starten"
```

---

## 🐳 Docker Deployment

### 1. Docker-Images bauen

```bash
# Production Build starten
docker compose -f docker-compose.production.yml build

# Oder einzeln bauen:
docker compose -f docker-compose.production.yml build backend
docker compose -f docker-compose.production.yml build frontend
docker compose -f docker-compose.production.yml build gm-client
```

### 2. Services starten

```bash
# Alle Services im Hintergrund starten
docker compose -f docker-compose.production.yml up -d

# Logs ansehen
docker compose -f docker-compose.production.yml logs -f

# Nur bestimmte Services ansehen
docker compose -f docker-compose.production.yml logs -f backend
```

### 3. Datenbank migrieren

```bash
# Warten bis PostgreSQL bereit ist
docker compose -f docker-compose.production.yml exec postgres pg_isready

# Migrationen ausführen
docker compose -f docker-compose.production.yml exec backend sh -c "cd /app/apps/backend && node_modules/.bin/drizzle-kit migrate"

# ODER mit direktem Zugriff:
docker compose -f docker-compose.production.yml exec backend npm run db:migrate
```

### 4. Seed-Daten importieren (Optional)

```bash
# Test-Account erstellen
docker compose -f docker-compose.production.yml exec backend npm run db:seed

# GeoJSON-Daten importieren
docker compose -f docker-compose.production.yml exec backend npm run seed
```

---

## 🌐 Nginx Reverse Proxy

### 1. Nginx-Konfiguration erstellen

```bash
sudo nano /etc/nginx/sites-available/jlw2026
```

Inhalt (siehe `nginx/jlw2026.conf` im Projekt):

```nginx
# Frontend (Spieler-App)
server {
    listen 80;
    server_name jlw2026.example.com;

    location / {
        proxy_pass http://localhost:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # WebSocket Support
    location = /api/v1/geo/ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }
}

# Backend API
server {
    listen 80;
    server_name api.jlw2026.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
    }
}

# GM Dashboard
server {
    listen 80;
    server_name gm.jlw2026.example.com;

    location / {
        proxy_pass http://localhost:5174;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }

    # Basic Auth für zusätzlichen Schutz
    auth_basic "GM Access";
    auth_basic_user_file /etc/nginx/.htpasswd;
}
```

### 2. Nginx aktivieren

```bash
# Symlink erstellen
sudo ln -s /etc/nginx/sites-available/jlw2026 /etc/nginx/sites-enabled/

# Default-Site deaktivieren (optional)
sudo rm /etc/nginx/sites-enabled/default

# Konfiguration testen
sudo nginx -t

# Nginx neu laden
sudo systemctl reload nginx
```

### 3. Basic Auth für GM Dashboard (Optional)

```bash
# htpasswd installieren
sudo apt install apache2-utils -y

# Passwort erstellen
sudo htpasswd -c /etc/nginx/.htpasswd gmadmin

# Passwort eingeben wenn aufgefordert
```

---

## 🔒 SSL/TLS mit Let's Encrypt

### 1. Certbot installieren

```bash
sudo apt install certbot python3-certbot-nginx -y
```

### 2. Zertifikate erstellen

```bash
# Für alle Domains auf einmal
sudo certbot --nginx -d jlw2026.example.com -d api.jlw2026.example.com -d gm.jlw2026.example.com

# ODER einzeln:
sudo certbot --nginx -d jlw2026.example.com
sudo certbot --nginx -d api.jlw2026.example.com
sudo certbot --nginx -d gm.jlw2026.example.com
```

### 3. Auto-Renewal testen

```bash
sudo certbot renew --dry-run
```

---

## 🔍 Health Checks

### Services überprüfen

```bash
# Docker Container Status
docker compose -f docker-compose.production.yml ps

# Backend Health
curl http://localhost:3000/health
curl https://api.jlw2026.example.com/health

# Frontend
curl http://localhost:5173
curl https://jlw2026.example.com

# GM Client
curl http://localhost:5174
curl https://gm.jlw2026.example.com

# PostgreSQL
docker compose -f docker-compose.production.yml exec postgres psql -U postgres -d jugendleiter2026 -c "SELECT version();"

# WebSocket über den öffentlichen Spieler-vHost (erwartet HTTP 101)
WS_TOKEN=<player-jwt> PLAYER_BASE_URL=https://jlw2026.example.com \
  ./scripts/test-websocket-deployment.sh
```

---

## 📊 Monitoring & Logs

### Logs ansehen

```bash
# Alle Services
docker compose -f docker-compose.production.yml logs -f

# Nur Backend
docker compose -f docker-compose.production.yml logs -f backend

# Nur Frontend
docker compose -f docker-compose.production.yml logs -f frontend

# Nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# System-Ressourcen
docker stats
```

### Log-Rotation einrichten

```bash
sudo nano /etc/logrotate.d/docker
```

Inhalt:
```
/var/lib/docker/containers/*/*.log {
    rotate 7
    daily
    compress
    size=10M
    missingok
    delaycompress
    copytruncate
}
```

---

## 🔄 Updates & Wartung

### Code Updates deployen

```bash
cd /opt/jlw2026

# Neuesten Code pullen
git pull origin main

# Images neu bauen
docker compose -f docker-compose.production.yml build

# Services neu starten (Zero-Downtime mit Blue-Green Deployment)
docker compose -f docker-compose.production.yml up -d --no-deps --build backend
docker compose -f docker-compose.production.yml up -d --no-deps --build frontend
docker compose -f docker-compose.production.yml up -d --no-deps --build gm-client

# Alte Images aufräumen
docker image prune -f
```

### Datenbank-Migrationen

```bash
# Neue Migrationen ausführen
docker compose -f docker-compose.production.yml exec backend npm run db:migrate

# Backup vor Migration (empfohlen!)
docker compose -f docker-compose.production.yml exec postgres pg_dump -U postgres jugendleiter2026 > backup_$(date +%Y%m%d_%H%M%S).sql
```

### Backup & Restore

#### Datenbank Backup
```bash
# Backup erstellen
docker compose -f docker-compose.production.yml exec postgres pg_dump -U postgres -Fc jugendleiter2026 > backup.dump

# Oder als SQL:
docker compose -f docker-compose.production.yml exec postgres pg_dump -U postgres jugendleiter2026 > backup.sql
```

#### Datenbank Restore
```bash
# Von .dump Datei:
docker compose -f docker-compose.production.yml exec -T postgres pg_restore -U postgres -d jugendleiter2026 < backup.dump

# Von .sql Datei:
docker compose -f docker-compose.production.yml exec -T postgres psql -U postgres -d jugendleiter2026 < backup.sql
```

#### S3 Media Backup
```bash
# S3 zu lokalem Verzeichnis syncen
aws s3 sync s3://jlw2026-media-production ./media-backup/

# Restore
aws s3 sync ./media-backup/ s3://jlw2026-media-production
```

---

## 🚨 Troubleshooting

### Container startet nicht

```bash
# Logs ansehen
docker compose -f docker-compose.production.yml logs backend

# Container neu starten
docker compose -f docker-compose.production.yml restart backend

# Volumes zurücksetzen (⚠️ ACHTUNG: Löscht Daten!)
docker compose -f docker-compose.production.yml down -v
docker compose -f docker-compose.production.yml up -d
```

### Datenbankverbindung fehlgeschlagen

```bash
# PostgreSQL Status prüfen
docker compose -f docker-compose.production.yml exec postgres pg_isready

# Connection String prüfen
docker compose -f docker-compose.production.yml exec backend env | grep DATABASE_URL

# PostgreSQL Logs
docker compose -f docker-compose.production.yml logs postgres
```

### Nginx Fehler

```bash
# Konfiguration testen
sudo nginx -t

# Logs ansehen
sudo tail -f /var/log/nginx/error.log

# Nginx neu starten
sudo systemctl restart nginx
```

### Disk Space voll

```bash
# Docker aufräumen
docker system prune -a --volumes

# Alte Logs löschen
sudo journalctl --vacuum-time=7d

# Disk Usage
df -h
du -sh /var/lib/docker/*
```

---

## 🔐 Sicherheit Checklist

- [ ] **Firewall**: Nur Ports 22, 80, 443 offen
- [ ] **SSH**: Key-basierte Authentifizierung, kein Root-Login
- [ ] **Passwörter**: Starke Passwörter für DB, JWT Secret mind. 32 Zeichen
- [ ] **SSL/TLS**: Let's Encrypt Zertifikate aktiv
- [ ] **GM Dashboard**: Basic Auth + JWT aktiviert
- [ ] **Fail2Ban**: SSH Brute-Force Schutz (optional)
- [ ] **Backups**: Automatische tägliche DB-Backups
- [ ] **Updates**: Regelmäßige System- und Docker-Updates
- [ ] **S3 Permissions**: Nur notwendige IAM-Rechte
- [ ] **Environment Variables**: Niemals in Git committen

---

## 📝 Deployment Checklist

Vor dem Go-Live:

- [ ] `.env.production` mit Production-Werten konfiguriert
- [ ] S3 Bucket erstellt und CORS konfiguriert
- [ ] DNS-Records gesetzt (A/CNAME für alle Subdomains)
- [ ] SSL-Zertifikate installiert und funktionierend
- [ ] Datenbank migriert (`db:migrate`)
- [ ] GeoJSON-Daten importiert (`seed`)
- [ ] Test-Accounts erstellt (`db:seed`)
- [ ] Health-Endpoints erreichbar
- [ ] WebSocket-Verbindung funktioniert
- [ ] Frontend lädt Karte korrekt (MapTiler API Key)
- [ ] GM Dashboard erreichbar und geschützt
- [ ] Backup-Strategie implementiert
- [ ] Monitoring/Alerting konfiguriert
- [ ] Load-Testing durchgeführt (optional)

---

## 🎯 Performance Tuning

### PostgreSQL Optimierung

```bash
# postgresql.conf anpassen (in Docker Volume)
docker compose -f docker-compose.production.yml exec postgres bash

# /var/lib/postgresql/data/postgresql.conf
shared_buffers = 256MB
effective_cache_size = 1GB
maintenance_work_mem = 64MB
checkpoint_completion_target = 0.9
wal_buffers = 16MB
default_statistics_target = 100
random_page_cost = 1.1
work_mem = 4MB
max_connections = 100
```

### Nginx Caching

```nginx
# In /etc/nginx/sites-available/jlw2026
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=my_cache:10m max_size=1g inactive=60m;

location /api/v1/public/ {
    proxy_cache my_cache;
    proxy_cache_valid 200 5m;
    proxy_pass http://localhost:3000;
}
```

---

## 📚 Nützliche Commands

```bash
# ─── Docker ──────────────────────────────────────────────────────────────────
# Alle Services neu starten
docker compose -f docker-compose.production.yml restart

# Nur einen Service neu starten
docker compose -f docker-compose.production.yml restart backend

# Services stoppen
docker compose -f docker-compose.production.yml down

# Services mit Volume-Cleanup stoppen
docker compose -f docker-compose.production.yml down -v

# ─── Logs ────────────────────────────────────────────────────────────────────
# Live Logs
docker compose -f docker-compose.production.yml logs -f

# Letzte 100 Zeilen
docker compose -f docker-compose.production.yml logs --tail=100

# ─── Database ────────────────────────────────────────────────────────────────
# PostgreSQL Shell
docker compose -f docker-compose.production.yml exec postgres psql -U postgres -d jugendleiter2026

# Query ausführen
docker compose -f docker-compose.production.yml exec postgres psql -U postgres -d jugendleiter2026 -c "SELECT COUNT(*) FROM teams;"

# ─── Monitoring ──────────────────────────────────────────────────────────────
# Container Stats
docker stats

# Disk Usage
docker system df

# ─── Maintenance ─────────────────────────────────────────────────────────────
# Alte Images/Container/Volumes löschen
docker system prune -a --volumes

# Nur ungenutzte Images
docker image prune -a
```

---

## 🆘 Support & Kontakt

Bei Problemen:
1. Logs prüfen: `docker compose logs -f`
2. Health-Endpoints testen
3. Troubleshooting-Sektion durchgehen
4. GitHub Issues erstellen

---

**Epic 1-9 Production Deployment Complete! 🚀**

_Erstellt: 2026-09-09_  
_Version: 1.0.0_
