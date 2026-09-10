# JLW2026 Production Status
**Stand: 10. September 2026, 20:55 Uhr**

---

## ✅ GETESTET & FUNKTIONIERT

### Core Gameplay
- [x] **Login-System** (Player & GM)
- [x] **GPS-Tracking & WebSockets** (Dezimal-Accuracy gefixt!)
- [x] **Proximity-Detection** (DISCOVERED, INTERACTING, AGGRO Zonen)
- [x] **Quest-System**
  - Quest annehmen
  - REACH_LOCATION Steps
  - DEFEAT_ENEMY Steps  
  - Quest abschließen
  - Belohnungen (Fame, Denarii)
- [x] **PvE Combat**
  - Automatischer Start bei AGGRO-Eintritt mit aktiver DEFEAT_ENEMY Quest
  - Rundenbasierter Kampf (15s Timer)
  - Attack/Defend Actions
  - Enemy AI (automatische Angriffe)
  - Combat Completion
  - Belohnungsvergabe
- [x] **Economy/Inventory**
  - Fame & Denarii Tracking
  - Ledger Entries
  - Item Definitions

### Admin/GM
- [x] **GM-Dashboard Login** (ohne Passwort)
- [x] **Respawn-Script** (`~/respawn-team.sh`)

### Getestete Accounts
- **Team 1**: `prototyp_player1` / Access Code: `test123` (Schweizer Gardist, Pfäffikon Test Team)
- **Team 2**: `prototyp_player2` / Access Code: `team2code` (Condottiere, Test Team 2)
- **GM**: `prototyp_gm` (kein Passwort nötig)

---

## ⚠️ NICHT GETESTET (WEGLASSEN!)

### Features die ich für Real-Life-Test WEGLASSEN würde:
- [ ] **PvP Combat** (komplex, ungetestet, hohes Bug-Risiko)
- [ ] **Item-System / Equipment** (nicht essential, könnte crashen)
- [ ] **Trade-System** (optional Feature)
- [ ] **Media Upload** (nice-to-have)
- [ ] **Puzzle/Questions** (falls nicht kern-gameplay)
- [ ] **Team Wipe & Auto-Respawn** (manuell via Script möglich)

### Bekannte Limitationen:
- **Respawn**: Nur manuell via `~/respawn-team.sh <TEAM_ID>`
- **Quest-Visibility**: Nur in DISCOVERED/INTERACTING Zone, nicht in AGGRO
- **Combat-Start**: Nur beim EINTRITT in AGGRO-Zone (nicht wenn schon drin)
- **Frontend GPS**: Überschreibt manuelle Test-Positionen

---

## 🔧 NOTFALL-BEFEHLE

### Player wiederbeleben (Team ID siehe unten)
```bash
~/respawn-team.sh <TEAM_ID>
```

### Alle Player heilen
```bash
docker compose -f ~/jlw2026/docker-compose.production.yml exec postgres psql -U postgres -d jugendleiter2026 -c "
UPDATE player SET status = 'ACTIVE', hp_current = 100;
"
```

### Quest zurücksetzen
```bash
docker compose -f ~/jlw2026/docker-compose.production.yml exec postgres psql -U postgres -d jugendleiter2026 -c "
DELETE FROM quest_run WHERE quest_definition_id = (SELECT id FROM quest_definition WHERE external_id = 'PT-Q01');
"
```

### Combat manuell beenden
```bash
docker compose -f ~/jlw2026/docker-compose.production.yml exec postgres psql -U postgres -d jugendleiter2026 -c "
UPDATE combat_instance SET state = 'COMPLETED' WHERE state IN ('AWAITING_ACTIONS', 'LOCKED');
"
```

### Backend Logs live anschauen
```bash
docker compose -f ~/jlw2026/docker-compose.production.yml logs -f backend
```

---

## 📍 WICHTIGE IDs & DATEN

### Team IDs
- **Team 1 (Pfäffikon Test Team)**: `f47ac10b-58cc-4372-a567-0e02b2c3d479`
- **Team 2 (Test Team 2)**: `2b9e3b4a-1234-5678-9abc-def012345678`

### URLs
- **Frontend**: https://jlw2026.lorenzheld.ch
- **GM-Dashboard**: https://jlw2026.lorenzheld.ch:5174
- **Backend API**: https://jlw2026.lorenzheld.ch/api/v1

---

## 🎮 TEST-KOORDINATEN (Pfäffikon SZ)

**Enemy Position (AGGRO):**
- Lat: `47.3741958`
- Lng: `8.7938204`

**DISCOVERED Zone (30m entfernt):**
- Lat: `47.37445`
- Lng: `8.79385`

**Außerhalb (für Transitions):**
- Lat: `47.373`
- Lng: `8.792`

---

## 🐛 GELÖSTE BUGS (während Setup)

1. ✅ GPS-Accuracy Type Error (Float → Integer cast)
2. ✅ Combat Routes: teamId Resolution
3. ✅ Quest Completion: Falsche Tabellennamen
4. ✅ Database Migrations: Epic 5 Inventory
5. ✅ Proximity States: AGGRO Zone Berechnung
6. ✅ Player Respawn: Status & HP

---

## 📊 AKTUELLE STATS

**Erfolgreich getestet:**
- 2 Quests (PT-Q01, PT-Q02-COMBAT)
- 1 Enemy (Leone del Flaminio)
- 1 Combat-Sieg
- Fame: 350, Denarii: 210

**Belohnungen funktionieren!** ✅
