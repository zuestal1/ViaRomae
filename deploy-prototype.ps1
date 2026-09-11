# Pfaeffikon Prototype Deployment Script (PowerShell)
# Startet eine separate Prototyp-Umgebung OHNE die Rom-Daten zu beruehren

Write-Host "===================================================================" -ForegroundColor Green
Write-Host "Starting Pfaeffikon Prototype Deployment" -ForegroundColor Green
Write-Host "===================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "This will NOT affect your main Rome database!" -ForegroundColor Yellow
Write-Host ""

# 1. Stoppe alte Prototyp-Container (falls vorhanden)
Write-Host "[PROTOTYPE] Stopping old prototype containers..." -ForegroundColor Cyan
docker compose -f docker-compose.prototype.yml down 2>$null

# 2. Starte neue Prototyp-Container
Write-Host "[PROTOTYPE] Starting prototype containers..." -ForegroundColor Cyan
docker compose -f docker-compose.prototype.yml up -d --build

# 3. Warte auf Datenbank
Write-Host "[PROTOTYPE] Waiting for PostgreSQL..." -ForegroundColor Cyan
Start-Sleep -Seconds 5

$maxRetries = 30
$retries = 0
while ($retries -lt $maxRetries) {
    $result = docker compose -f docker-compose.prototype.yml exec -T postgres-prototype pg_isready -U postgres 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[PROTOTYPE] PostgreSQL ready!" -ForegroundColor Green
        break
    }
    Write-Host "  Waiting for database... (attempt $($retries + 1)/$maxRetries)" -ForegroundColor Gray
    Start-Sleep -Seconds 2
    $retries++
}

if ($retries -eq $maxRetries) {
    Write-Host "[ERROR] PostgreSQL failed to start!" -ForegroundColor Red
    exit 1
}

# 4. Fuehre Migrationen aus
Write-Host "[PROTOTYPE] Running database migrations..." -ForegroundColor Cyan
docker compose -f docker-compose.prototype.yml exec -T backend-prototype npm run db:migrate

# 5. Lade Prototyp-Daten
Write-Host "[PROTOTYPE] Loading Pfaeffikon prototype data..." -ForegroundColor Cyan
docker compose -f docker-compose.prototype.yml exec -T backend-prototype npm run seed:prototype

# 6. Health Check
Write-Host "[PROTOTYPE] Running health check..." -ForegroundColor Cyan
Start-Sleep -Seconds 3

try {
    $response = Invoke-WebRequest -Uri "http://localhost:3001/health" -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) {
        Write-Host "[PROTOTYPE] Backend health check passed" -ForegroundColor Green
    }
} catch {
    Write-Host "[WARNING] Backend health check failed (might still be starting...)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "===================================================================" -ForegroundColor Green
Write-Host "Prototype Deployment Complete!" -ForegroundColor Green
Write-Host "===================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Pfaeffikon Prototype is running on:" -ForegroundColor Cyan
Write-Host "   Backend:  http://localhost:3001" -ForegroundColor White
Write-Host "   Frontend: http://localhost:5175" -ForegroundColor White
Write-Host "   Database: localhost:5433 (jugendleiter2026_prototype)" -ForegroundColor White
Write-Host ""
Write-Host "Test Credentials:" -ForegroundColor Cyan
Write-Host "   Player 1: prototyp_player1 / test123" -ForegroundColor White
Write-Host "   Player 2: prototyp_player2 / test123" -ForegroundColor White
Write-Host "   GM:       prototyp_gm / test123" -ForegroundColor White
Write-Host ""
Write-Host "Test Area: Pfaeffikon ZH - Im Berg" -ForegroundColor Cyan
Write-Host ""
Write-Host "Your main Rome database is UNTOUCHED:" -ForegroundColor Yellow
Write-Host "   Backend:  http://localhost:3000" -ForegroundColor White
Write-Host "   Database: localhost:5432 (jugendleiter2026)" -ForegroundColor White
Write-Host ""
Write-Host "To stop prototype:" -ForegroundColor Cyan
Write-Host "   docker compose -f docker-compose.prototype.yml down" -ForegroundColor White
Write-Host ""
Write-Host "View logs:" -ForegroundColor Cyan
Write-Host "   docker compose -f docker-compose.prototype.yml logs -f" -ForegroundColor White
Write-Host "===================================================================" -ForegroundColor Green

Write-Host "Warte auf Datenbank-Bereitschaft..."
Start-Sleep -Seconds 5

Write-Host "Führe Datenbank-Migrationen aus..."
docker compose -f docker-compose.prototype.yml exec -T backend-prototype npm run db:migrate

Write-Host "Spiele Prototyp-Seed-Daten ein..."
docker compose -f docker-compose.prototype.yml exec -T backend-prototype npm run seed:prototype
