# ============================================================================
# ALLES NEU - Complete Reset and Fresh Start
# ============================================================================
# This script performs a COMPLETE cleanup and fresh start:
# 1. Kills ALL Node/pnpm processes
# 2. Stops and REMOVES all Docker containers
# 3. DELETES all Docker volumes (removes all DB data!)
# 4. Starts fresh PostgreSQL
# 5. Runs ALL migrations (0000-0011)
# 6. Fixes missing column (migration 0010 workaround)
# 7. Seeds with Rome data (filter bypassed)
# 8. Creates test accounts
# 9. Starts backend + frontend
# ============================================================================

$ErrorActionPreference = "Stop"
$PROJECT_ROOT = "C:\Users\heldl\Projekte\jugendleiterweekend2026"

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  ALLES NEU - Complete Reset" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Kill all Node/pnpm processes ─────────────────────────────────────
Write-Host "[1/7] Killing all Node/pnpm processes..." -ForegroundColor Yellow
try {
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Name "pnpm" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    Write-Host "  => All processes killed" -ForegroundColor Green
} catch {
    Write-Host "  => No processes to kill" -ForegroundColor Gray
}

# ── Step 2: Stop all Docker containers ───────────────────────────────────────
Write-Host ""
Write-Host "[2/7] Stopping all Docker containers..." -ForegroundColor Yellow
docker stop $(docker ps -aq) 2>$null
Write-Host "  => Containers stopped" -ForegroundColor Green

# ── Step 3: Remove all Docker containers ─────────────────────────────────────
Write-Host ""
Write-Host "[3/7] Removing all Docker containers..." -ForegroundColor Yellow
docker rm $(docker ps -aq) 2>$null
Write-Host "  => Containers removed" -ForegroundColor Green

# ── Step 4: Delete all Docker volumes (THIS DELETES ALL DATA!) ───────────────
Write-Host ""
Write-Host "[4/7] Deleting all Docker volumes (ALL DATA WILL BE LOST!)..." -ForegroundColor Red
docker volume prune -af
Write-Host "  => All volumes deleted" -ForegroundColor Green

# ── Step 5: Start fresh PostgreSQL ───────────────────────────────────────────
Write-Host ""
Write-Host "[5/7] Starting fresh PostgreSQL container..." -ForegroundColor Yellow
docker run -d `
  --name postgres-prototype `
  -e POSTGRES_USER=viaromae `
  -e POSTGRES_PASSWORD=dev_password_2026 `
  -e POSTGRES_DB=viaromae_prototype `
  -p 5433:5432 `
  postgis/postgis:16-3.5

Start-Sleep -Seconds 8
Write-Host "  => PostgreSQL started" -ForegroundColor Green

# ── Step 6: Run ALL migrations ───────────────────────────────────────────────
Write-Host ""
Write-Host "[6/9] Running ALL migrations (0000-0011)..." -ForegroundColor Yellow
Push-Location "$PROJECT_ROOT\apps\backend"
$env:DATABASE_URL = "postgresql://viaromae:dev_password_2026@localhost:5433/viaromae_prototype"
pnpm run db:migrate
Pop-Location
Write-Host "  => Migrations applied" -ForegroundColor Green

# ── Step 7: Fix missing column (migration 0010 workaround) ──────────────────
Write-Host ""
Write-Host "[7/9] Fixing missing boss_join_radius_m column..." -ForegroundColor Yellow
docker exec postgres-prototype psql -U viaromae -d viaromae_prototype -c "ALTER TABLE world_object ADD COLUMN IF NOT EXISTS boss_join_radius_m integer NOT NULL DEFAULT 30;" 2>$null
Write-Host "  => Column fixed" -ForegroundColor Green

# ── Step 8: Seed with Rome data ──────────────────────────────────────────────
Write-Host ""
Write-Host "[8/9] Seeding database with Rome data..." -ForegroundColor Yellow
Push-Location "$PROJECT_ROOT\apps\backend"
$env:DATABASE_URL = "postgresql://viaromae:dev_password_2026@localhost:5433/viaromae_prototype"
$env:SEED_SKIP_FILTER = "true"
pnpm exec tsx scripts/seed.ts
$seedResult = $LASTEXITCODE
Pop-Location

if ($seedResult -eq 0) {
    Write-Host "  => Seeding successful!" -ForegroundColor Green
} else {
    Write-Host "  => ERROR: Seeding failed!" -ForegroundColor Red
    exit 1
}

# ── Step 9: Create test accounts ─────────────────────────────────────────────
Write-Host ""
Write-Host "[9/9] Creating test accounts..." -ForegroundColor Yellow
docker exec postgres-prototype psql -U viaromae -d viaromae_prototype -c "INSERT INTO account (username, access_code_hash, role) VALUES ('testuser', '\`$2a\`$10\`$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'PLAYER'), ('gm', '\`$2a\`$10\`$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'GM') ON CONFLICT (username) DO NOTHING;" 2>$null
docker exec postgres-prototype psql -U viaromae -d viaromae_prototype -c "WITH acc AS (SELECT id FROM account WHERE username = 'testuser' LIMIT 1), new_team AS (INSERT INTO team (name, inventory_capacity) VALUES ('Test Team', 40) ON CONFLICT DO NOTHING RETURNING id) INSERT INTO player (account_id, team_id, class, hp_current, status) SELECT acc.id, new_team.id, 'swiss_guard', 100, 'ACTIVE' FROM acc, new_team ON CONFLICT DO NOTHING;" 2>$null
Write-Host "  => Accounts created (testuser / test123)" -ForegroundColor Green

# ── Step 10: Start Backend & Frontend ────────────────────────────────────────
Write-Host ""
Write-Host "Starting Backend (Port 3001)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PROJECT_ROOT\apps\backend'; `$env:DATABASE_URL='postgresql://viaromae:dev_password_2026@localhost:5433/viaromae_prototype'; `$env:PORT=3001; pnpm run dev"

Write-Host "Starting Frontend (Port 5175)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PROJECT_ROOT\apps\frontend'; `$env:VITE_BACKEND_URL='http://localhost:3001'; `$env:PORT=5175; pnpm run dev -- --port 5175"

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "  DONE! System is starting..." -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""
Write-Host "Wait 30 seconds, then open:" -ForegroundColor Cyan
Write-Host "  http://localhost:5175" -ForegroundColor White
Write-Host ""
Write-Host "Login credentials:" -ForegroundColor Cyan
Write-Host "  Username: testuser" -ForegroundColor White
Write-Host "  Password: test123" -ForegroundColor White
Write-Host ""
Write-Host "Database contains:" -ForegroundColor Cyan
Write-Host "  - 102 WorldObjects (90 Locations + 12 Enemies)" -ForegroundColor Gray
Write-Host "  - 40 Quest Definitions" -ForegroundColor Gray
Write-Host "  - 2 Accounts, 1 Team, 1 Player" -ForegroundColor Gray
Write-Host ""
