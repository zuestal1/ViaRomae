# GM Dashboard – Quick Start Guide

## 🚀 Setup

### 1. Backend starten
```bash
cd apps/backend
npm run dev
```

Backend läuft auf: `http://localhost:3000`

### 2. Migration anwenden
```bash
cd apps/backend
npm run migrate
```

Führt `0011_epic9_gm_operations.sql` aus und erstellt die Event-State-Tabelle.

### 3. GM Client starten
```bash
cd apps/gm-client
npm run dev
```

GM Dashboard läuft auf: `http://localhost:5174`

---

## 🔐 Login

Das Dashboard zeigt beim ersten Aufruf eine eigene GM-Anmeldung. Verwende dort
den Zugangscode eines Accounts mit Rolle `GM` oder `ADMIN`.

Die Sitzung wird beim Start serverseitig geprüft; abgelaufene oder unberechtigte
Sitzungen führen automatisch zurück zur Anmeldung.

---

## 🎮 Dashboard-Übersicht

### Header
- **Event Status Badge**: Zeigt aktuellen Event-Zustand (Not Started / Active / Paused / Ended)
- **Event Controls**: Buttons zum Starten/Pausieren/Beenden des Events

### Sidebar (links)
- **Team Status Panel**: Echtzeit-Übersicht aller Teams mit HP, Fame, Denarii, aktiven Quests

### Tabs (Hauptbereich)

#### 🗺️ Live Map
- **Player-Marker** (blaue Punkte): Zeigt alle Spieler-Positionen in Echtzeit
- **WorldObject-Marker** (farbig): Zeigt alle WorldObjects (grün=published, rot=Boss, orange=Enemy, grau=Draft)
- **Legende**: Links oben, erklärt Marker-Farben
- **Stats**: Links unten, zeigt Anzahl Spieler und Objekte

**Interaktion**: Klicke auf Marker für Details (Name, Team, letztes Update)

#### 📸 Media Inbox
- **Liste** (links): Alle ausstehenden Media-Submissions
- **Review-Panel** (rechts): 
  - Media-Vorschau (aktuell Placeholder)
  - Score-Slider (0-10): 0-4 = Rejected, 5-10 = Approved
  - Grund (optional): Feedback für das Team
  - Submit-Button: Führt Review aus und vergibt Belohnungen

**Belohnungen**:
- Score 1-10: FAME (1:1)
- Score 7-10: Bonus Denarii (7→10, 8→20, 9→30, 10→40)

#### ⚙️ Commands
Administrative Eingriffe mit Audit-Logging:

1. **💊 HP Override**
   - Team ID eingeben
   - Neuer HP-Wert
   - Für Notfall-Korrekturen bei HP-Bugs

2. **💰 Currency Correction**
   - Team ID
   - Währungstyp (FAME/DENARII)
   - Betrag (positiv = hinzufügen, negativ = entfernen)
   - Grund (Pflicht, für Audit-Trail)

3. **📍 Location Override**
   - Player ID
   - Neue Koordinaten (Lat/Lng)
   - Für festsitzende Spieler

4. **🔄 Quest Reset**
   - Quest Run ID
   - Setzt Quest auf ACTIVE zurück und löscht Fortschritt

**Hinweis**: Alle Commands werden im Audit-Log gespeichert.

#### 🏆 Leaderboard
- **Event Summary**: Statistiken (Teams, Quests, Dauer, Währung)
- **Team-Rankings**: Sortiert nach FAME, dann DENARII
- Medaillen für Top 3 (🥇🥈🥉)

---

## 🔧 Häufige Aufgaben

### Event starten
1. Öffne Dashboard
2. Stelle sicher, dass Status "Not Started" ist
3. Klicke "▶️ Start Event" im Header
4. Status wechselt zu "Active"

### Media-Submission bewerten
1. Wechsle zu "📸 Media Inbox"
2. Wähle Submission aus der Liste
3. Setze Score mit Slider (0-10)
4. Optional: Gib Feedback ein
5. Klicke "Approve" oder "Reject"
6. Team erhält automatisch Belohnungen

### Team-HP korrigieren
1. Wechsle zu "⚙️ Commands"
2. Klicke "💊 HP Override"
3. Gib Team-ID ein (aus Sidebar kopieren)
4. Setze neuen HP-Wert
5. Klicke "Execute"

### Währung hinzufügen/entfernen
1. Wechsle zu "⚙️ Commands"
2. Klicke "💰 Currency Correction"
3. Gib Team-ID ein
4. Wähle Währungstyp (FAME/DENARII)
5. Gib Betrag ein (negativ für Abzug)
6. Gib Grund ein (Pflicht!)
7. Klicke "Execute"

### Event beenden
1. Klicke "🏁 End Event" im Header
2. Bestätige im Popup
3. Event wechselt zu "Ended"
4. Leaderboard wird eingefroren

---

## 📊 Live-Daten

Alle Dashboard-Daten werden **alle 5 Sekunden** automatisch aktualisiert:
- Player-Positionen
- Team-Status (HP, Fame, Denarii)
- Media-Inbox
- Leaderboard

**Keine manuelle Aktualisierung nötig!**

---

## 🐛 Troubleshooting

### "Failed to fetch" Fehler
- Prüfe, ob Backend läuft (`http://localhost:3000`)
- Prüfe JWT-Token im LocalStorage
- Öffne Browser DevTools → Network Tab für Details

### Leere Map
- Prüfe, ob Teams/Spieler Location-Updates gesendet haben
- Öffne Browser DevTools → Console für Fehler
- Prüfe, ob WorldObjects in der DB sind (`SELECT * FROM world_object LIMIT 10;`)

### Command schlägt fehl
- Prüfe, ob IDs korrekt sind (UUID-Format)
- Prüfe Backend-Logs für detaillierte Fehler
- Öffne `/audit-log` im Browser für Command-Historie

---

## 🔒 Sicherheit

**Wichtig**:
- GM-Dashboard ist aktuell **nicht** öffentlich zugänglich (nur über `localhost:5174`)
- Für Production: 
  - Eigene Subdomain (`gm.jlw2026.example.com`)
  - HTTPS-Pflicht
  - RBAC (Role-Based Access Control) für Admin-Rolle
  - Rate Limiting für Commands

---

## 📝 Audit-Log

Alle GM-Actions werden geloggt. Zugriff via API:

```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:3000/api/v1/gm/audit-log?limit=50&offset=0"
```

**Filterbar nach**:
- `actorId` (GM Account ID)
- `action` (z.B. "HP_OVERRIDE", "CURRENCY_CORRECTION")
- `limit` / `offset` (Pagination)

---

## 🚧 Bekannte Einschränkungen

1. **Keine Media-Vorschau**: S3-Integration für Bilder/Videos fehlt noch (Placeholder)
2. **Kein Seed-Trigger-UI**: Seed-Control nur via API (`POST /api/v1/gm/seed/trigger`)
3. **Kein GM-Login**: Manuelles Token-Setzen via DevTools
4. **Keine WebSocket-Updates**: Dashboard nutzt Polling (5s), nicht Push

---

## 💡 Tipps

- **Sidebar**: Nutze Team-Namen aus Sidebar für schnelles ID-Lookup (copy-paste in Commands)
- **Map-Zoom**: Nutze Mausrad zum Zoomen, Drag zum Verschieben
- **Multi-Monitor**: Dashboard ist Desktop-optimiert, ideal für zweiten Monitor
- **Browser**: Chrome/Edge empfohlen (bessere MapLibre-Performance)

---

## 📚 Weitere Dokumentation

- **Epic 9 Summary**: `EPIC9_SUMMARY.md` (vollständige Implementation-Details)
- **API-Docs**: Backend OpenAPI/Swagger (coming soon)
- **Contracts**: `packages/contracts/src/schemas/gm.ts` (TypeScript-Typen)

---

**Viel Erfolg beim Event! 🎉**
