#!/bin/bash
###############################################################################
# Deploy Script for JLW 2026 - Ubuntu Server
###############################################################################
# Usage: ./deploy.sh [environment]
# Example: ./deploy.sh production
###############################################################################

set -e  # Exit on error

# ─── Configuration ───────────────────────────────────────────────────────────
ENVIRONMENT="${1:-production}"
ENV_FILE=".env.${ENVIRONMENT}"
DOCKER_COMPOSE_FILE="docker-compose.production.yml"
PROJECT_NAME="jlw2026"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ─── Helper Functions ────────────────────────────────────────────────────────
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    if ! command -v $1 &> /dev/null; then
        log_error "$1 is not installed. Please install it first."
        exit 1
    fi
}

# ─── Pre-flight Checks ───────────────────────────────────────────────────────
log_info "Starting deployment for environment: ${ENVIRONMENT}"

# Check required commands
check_command docker
check_command git

# Check if env file exists
if [ ! -f "$ENV_FILE" ]; then
    log_error "Environment file $ENV_FILE not found!"
    log_info "Please create it from .env.example"
    exit 1
fi

# Load environment variables
log_info "Loading environment from $ENV_FILE"
export $(cat $ENV_FILE | grep -v '^#' | xargs)

# ─── Git Operations ──────────────────────────────────────────────────────────
log_info "Pulling latest code from git..."
git fetch origin
CURRENT_COMMIT=$(git rev-parse HEAD)
log_info "Current commit: ${CURRENT_COMMIT:0:8}"

# Optional: Check if we're on the right branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
log_info "Current branch: $BRANCH"

# ─── Backup Database ─────────────────────────────────────────────────────────
log_info "Creating database backup..."
BACKUP_DIR="./backups"
mkdir -p $BACKUP_DIR
BACKUP_FILE="${BACKUP_DIR}/backup_$(date +%Y%m%d_%H%M%S).sql"

if docker compose -f $DOCKER_COMPOSE_FILE --env-file $ENV_FILE ps postgres | grep -q "Up"; then
    docker compose -f $DOCKER_COMPOSE_FILE --env-file $ENV_FILE exec -T postgres \
        pg_dump -U ${POSTGRES_USER:-postgres} ${POSTGRES_DB:-jugendleiter2026} > "$BACKUP_FILE" 2>/dev/null || true
    
    if [ -f "$BACKUP_FILE" ]; then
        log_info "Backup created: $BACKUP_FILE"
        
        # Keep only last 7 backups
        ls -t $BACKUP_DIR/backup_*.sql | tail -n +8 | xargs -r rm
    else
        log_warn "Backup failed, but continuing deployment..."
    fi
else
    log_warn "PostgreSQL container not running, skipping backup"
fi

# ─── Build Docker Images ─────────────────────────────────────────────────────
log_info "Building Docker images..."
docker compose -f $DOCKER_COMPOSE_FILE --env-file $ENV_FILE build --no-cache

# ─── Stop Old Containers ─────────────────────────────────────────────────────
log_info "Stopping old containers..."
docker compose -f $DOCKER_COMPOSE_FILE --env-file $ENV_FILE down

# ─── Start New Containers ────────────────────────────────────────────────────
log_info "Starting new containers..."
docker compose -f $DOCKER_COMPOSE_FILE --env-file $ENV_FILE up -d

# ─── Wait for Services ───────────────────────────────────────────────────────
log_info "Waiting for services to be healthy..."
sleep 10

# Check PostgreSQL
log_info "Checking PostgreSQL..."
until docker compose -f $DOCKER_COMPOSE_FILE --env-file $ENV_FILE exec -T postgres pg_isready -U ${POSTGRES_USER:-postgres} > /dev/null 2>&1; do
    log_warn "PostgreSQL is unavailable - sleeping"
    sleep 2
done
log_info "PostgreSQL is up!"

# Check Backend
log_info "Checking Backend..."
MAX_RETRIES=30
RETRY_COUNT=0
until curl -f http://localhost:3000/health > /dev/null 2>&1 || [ $RETRY_COUNT -eq $MAX_RETRIES ]; do
    log_warn "Backend is unavailable - sleeping (attempt $((RETRY_COUNT+1))/$MAX_RETRIES)"
    sleep 2
    RETRY_COUNT=$((RETRY_COUNT+1))
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    log_error "Backend failed to start!"
    docker compose -f $DOCKER_COMPOSE_FILE --env-file $ENV_FILE logs backend
    exit 1
fi
log_info "Backend is up!"

# Fail closed if content, teams or participant accounts are incomplete.
log_info "Running release preflight (content + event roster)..."
docker compose -f $DOCKER_COMPOSE_FILE --env-file $ENV_FILE run --rm \
    -e EXPECTED_PLAYER_COUNT="${EXPECTED_PLAYER_COUNT:-0}" \
    -e EXPECTED_TEAM_COUNT="${EXPECTED_TEAM_COUNT:-0}" \
    backend pnpm run release:preflight

# ─── Health Checks ───────────────────────────────────────────────────────────
log_info "Running health checks..."

# Backend health
BACKEND_HEALTH=$(curl -s http://localhost:3000/health || echo "fail")
if [[ "$BACKEND_HEALTH" == *'"status":"ok"'* ]]; then
    log_info "✓ Backend health check passed"
else
    log_error "✗ Backend health check failed"
    docker compose -f $DOCKER_COMPOSE_FILE --env-file $ENV_FILE logs --tail=50 backend
    exit 1
fi

# Frontend health
FRONTEND_HEALTH=$(curl -s http://localhost:5173/health || echo "fail")
if [[ "$FRONTEND_HEALTH" == *"healthy"* ]]; then
    log_info "✓ Frontend health check passed"
else
    log_warn "✗ Frontend health check failed (might be OK if using Nginx)"
fi

# GM Client health
GM_HEALTH=$(curl -s http://localhost:5174/health || echo "fail")
if [[ "$GM_HEALTH" == *"healthy"* ]]; then
    log_info "✓ GM Client health check passed"
else
    log_warn "✗ GM Client health check failed (might be OK if using Nginx)"
fi

# ─── Cleanup ─────────────────────────────────────────────────────────────────
log_info "Cleaning up old Docker images..."
docker image prune -f

# ─── Summary ─────────────────────────────────────────────────────────────────
log_info "═══════════════════════════════════════════════════════════════════"
log_info "Deployment completed successfully! 🚀"
log_info "═══════════════════════════════════════════════════════════════════"
log_info "Environment: ${ENVIRONMENT}"
log_info "Commit: ${CURRENT_COMMIT:0:8}"
log_info "Timestamp: $(date)"
log_info ""
log_info "Services:"
log_info "  - Backend:    http://localhost:3000"
log_info "  - Frontend:   http://localhost:5173"
log_info "  - GM Client:  http://localhost:5174"
log_info ""
log_info "Next steps:"
log_info "  1. Check logs: docker compose -f $DOCKER_COMPOSE_FILE --env-file $ENV_FILE logs -f"
log_info "  2. Check status: docker compose -f $DOCKER_COMPOSE_FILE --env-file $ENV_FILE ps"
log_info "  3. Test endpoints: curl http://localhost:3000/health"
log_info "═══════════════════════════════════════════════════════════════════"
