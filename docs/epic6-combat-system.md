# Epic 6: Combat System - Implementierungsdokumentation

## Übersicht

Das Combat System implementiert ein rundenbasiertes Kampfsystem für sowohl PvE (Player vs Environment) als auch PvP (Player vs Player) Kämpfe.

## Architektur

### Backend-Komponenten

#### 1. Combat Service (`apps/backend/src/modules/combat/combat.service.ts`)

**State Machine:**
- `INITIALIZING` → Combat wird aufgesetzt
- `AWAITING_ACTIONS` → Warten auf Spieler-Aktionen (15 Sekunden Timer)
- `LOCKED` → Aktionen gesperrt, Auflösung beginnt
- `RESOLVING` → Runde wird aufgelöst
- `COMPLETED` → Combat beendet

**Hauptfunktionen:**
- `startPvECombat()` - Startet PvE-Encounter
- `getCombatInstance()` - Lädt vollständiges Combat-Objekt
- `submitCombatAction()` - Spieler reicht Aktion ein
- `lockAndResolveRound()` - Sperrt Runde und berechnet Ergebnisse
- `handleTeamWipe()` - idempotente GDD-Wipefolgen und Auswahl des nächsten Respawnpunkts
- `regenerateHPOutOfCombat()` - lineare Regeneration auf 100 % in 900 Sekunden

**PvP-Funktionen:**
- `checkPvPProximity()` - Prüft Nähe zu anderen Teams (60m Sichtbarkeit)
- `isInSafeZone()` - Prüft ob Spieler in Safe-Zone ist
- `startPvPChallenge()` - Startet 20-Sekunden-Warnung
- `schedulePvPEscalation()` - Plant automatische Eskalation zum Kampf

**Damage-Berechnung:** Die serverautoritative Pipeline folgt GDD 7.9-7.11. Sie
verwendet effektive Klassen-/Ausrüstungswerte, Fähigkeitsmultiplikator,
Damage-Dealt, `DEF / (DEF + 50)`, Damage-Taken, kaufmännische Endrundung sowie
Shield vor HP. Es gibt keinen allgemeinen Zufallsschaden oder kritischen Treffer.

#### 2. Combat Routes (`apps/backend/src/modules/combat/combat.routes.ts`)

**Endpoints:**
- `GET /api/v1/combat/:id` - Abrufen eines Combat-Instances
- `GET /api/v1/combat/team/active` - Aktives Combat für eigenes Team
- `POST /api/v1/combat/:id/action` - Aktion einreichen
- `POST /api/v1/combat/:id/resolve` - Runde manuell auflösen (GM/Testing)
- `WS /api/v1/combat/:id/ws` - WebSocket für Live-Updates

#### 3. Geo-Service Integration (`apps/backend/src/modules/geo/geo.service.ts`)

**PvE-Encounter-Trigger:**
- Prüft bei Location-Update ob Team in `enemy_aggro_radius_m` (20m) eintritt
- Validiert ob Team aktiven `DEFEAT_ENEMY`-QuestStep hat
- Startet automatisch Combat-Instance bei Match

```typescript
// In updatePlayerLocation():
await checkPvEEncounterTrigger({
  playerId: player.id,
  teamId: player.teamId,
  transitions: changed,
  nearbyObjects: nearbyAsSpatial,
  wsHub,
});
```

### Database Schema

**Tabellen:**
- `combat_instance` - Combat-Instanzen
  - `type`: PVE | PVP | BOSS
  - `state`: State-Machine-Status
  - `round_number`: Aktuelle Runde
  
- `combatant` - Teilnehmer am Kampf
  - `entity_type`: PLAYER | ENEMY
  - `entity_id`: Referenz zu Player oder WorldObject
  - `hp_current`: Aktuelles HP
  
- `combat_action` - Eingereichte Aktionen
  - `action_type`: ATTACK | DEFEND | SKILL | FLEE
  - `target_id`: Ziel der Aktion
  - `is_locked`: Ob Aktion gesperrt ist
  - `idempotency_key`: Verhindert Duplikate
  
- `pvp_challenge` - PvP-Herausforderungen
  - `state`: WARNING | ESCAPED | COMBAT
  - `expires_at`: Ablauf der Warnphase

### Frontend-Komponenten

#### 1. Combat Screen (`apps/frontend/src/components/combat/combat-screen.tsx`)

**Features:**
- Fullscreen-Overlay
- HP-Balken für alle Combatants
- Zielauswahl für Angriffe
- 4 Action-Buttons: Attack, Defend, Skill, Flee
- Combat-Log (zeigt letzte 5 Einträge)
- Status-Anzeige (Round, State)

**Props:**
```typescript
interface CombatScreenProps {
  combat: CombatInstance;
  playerId: string;
  onSubmitAction: (actionType: ActionType, targetId?: string) => void;
  onClose: () => void;
}
```

#### 2. PvP Challenge Warning (`apps/frontend/src/components/combat/pvp-challenge-warning.tsx`)

**Features:**
- 20-Sekunden Countdown
- Unterschiedliche Anzeige für Attacker/Defender
- Progress Bar
- Escape-Instruktionen für Defender
- Animierte Warning-Icon

#### 3. Combat Hook (`apps/frontend/src/hooks/use-combat.ts`)

**Funktionen:**
```typescript
const {
  activeCombat,      // Aktuelles Combat oder null
  logs,              // Combat-Log-Einträge
  isLoading,
  error,
  submitAction,      // Aktion einreichen
  fetchActiveCombat, // Combat laden
  handleCombatStarted,
  handleRoundResolved,
  handleCombatCompleted,
} = useCombat(playerId, token);
```

### Contracts (`packages/contracts/src/schemas/combat.ts`)

**Exported Types:**
- `CombatInstance`
- `Combatant`
- `CombatAction`
- `CombatLog`
- `CombatType` / `CombatState` / `ActionType` / `EntityType`

**WebSocket Events:**
- `CombatStartedEvent`
- `CombatActionSubmittedEvent`
- `CombatRoundResolvedEvent`
- `CombatCompletedEvent`
- `PvPChallengeStartedEvent`
- `PvPChallengeEscapedEvent`
- `TeamWipedEvent`

## PvE-Workflow

1. **Trigger:** Team betritt `enemy_aggro_radius_m` (20m) mit aktivem `DEFEAT_ENEMY` QuestStep
2. **Initialisierung:** 
   - Combat-Instance wird erstellt (Type: PVE)
   - Combatants für alle Team-Spieler werden angelegt
   - Enemy-Combatant wird aus WorldObject-Daten erstellt
3. **Runde 1 Start:**
   - State → `AWAITING_ACTIONS`
   - 15-Sekunden Timer startet
4. **Spieler-Aktionen:**
   - Jeder Spieler reicht eine Aktion ein (Attack/Defend/Skill/Flee)
   - Aktionen werden mit Idempotency-Key gespeichert
5. **Auto-Lock:**
   - Nach 15 Sekunden oder wenn alle Aktionen eingereicht
   - State → `LOCKED`
6. **Auflösung:**
   - State → `RESOLVING`
   - KI-Aktionen für Enemies werden generiert
   - Aktionen nach Initiative sortiert
   - Schaden berechnen und anwenden
   - Combat-Log erstellen
7. **Nächste Runde oder Ende:**
   - Wenn alle Enemies oder alle Spieler downed → `COMPLETED`
   - Sonst → `AWAITING_ACTIONS` (Runde++)
8. **Loot & Quest-Completion:**
   - Bei Sieg: `resolveDefeatEnemy()` im Quest-Service
   - Loot vergeben, Quest-Step completieren

## PvP-Workflow

1. **Proximity Detection:** 
   - Team A kommt in 60m-Sichtbarkeit zu Team B
   - Kein Safe-Zone-Check für beide Teams
2. **Challenge Start:**
   - `startPvPChallenge()` aufrufen
   - PvP-Challenge mit State `WARNING` erstellen
   - 20-Sekunden Timer starten
3. **Warning Phase:**
   - Beide Teams sehen Warn-Screen
   - Defender kann fliehen (>20m entfernen) oder Safe-Zone erreichen
4. **Eskalation:**
   - Nach 20 Sekunden: GPS-Validierung
   - Wenn Distanz >20m oder Defender in Safe-Zone → `ESCAPED`
   - Sonst → PvP-Combat startet (State: `COMBAT`)
5. **PvP-Combat:**
   - Gleicher Ablauf wie PvE
   - Flee-Button ist deaktiviert
   - Bei Verlust: Loot an Gewinner, Denar-Abzug

## Safe Zones

**Implementierung:**
- WorldObjects mit Type `SAFE_ZONE`
- `isInSafeZone()` prüft ob Spieler innerhalb `interaction_radius_m` ist
- PvP-Trigger werden in Safe-Zones deaktiviert
- Laufende PvP-Challenges können in Safe-Zone beendet werden

## Team Wipe & Respawn

**Bei vollständigem Team-Down:** Pro Downed werden 10 Teamdenare abgezogen. Der
vollständige Wipe kostet zusätzlich 10 % der aktuellen Teamdenare und 3 % des
aktuellen Teamruhms (maximal 100). Das Team bleibt DOWNED, bis der Server die
Ankunft am nächsten aktiven Respawnpunkt bestätigt; dann werden volle HP und
`ACTIVE` gesetzt.

## HP-Regeneration

**Out-of-Combat:**
- `regenerateHPOutOfCombat()` wird periodisch aufgerufen
- `maxHP / 900` pro Sekunde
- bis zum persönlichen, GDD-konform abgeleiteten maxHP
- Nur wenn kein aktives Combat für Team

## Konstanten

```typescript
const ROUND_TIMER_MS = 15_000;              // 15 Sekunden pro Runde
const PVP_WARNING_TIMER_MS = 20_000;        // 20 Sekunden PvP-Warnung
const PVP_AGGRO_RADIUS_M = 20;              // 20m Angriffsradius
const PVP_VISIBILITY_RADIUS_M = 60;         // 60m Sichtbarkeit
const HP_REGEN_OUT_OF_COMBAT = 5;           // 5 HP/s Regeneration
const PVP_ESCAPE_RADIUS_M = 30;             // >30m, zwei gültige Messungen
```

## Offene, im GDD noch nicht beschlossene Erweiterungen

Konkrete World-Boss-Phasen, dynamische HP-Skalierung und die Balancewirkung der
Applausmechanik sind laut GDD 26 offen und werden deshalb nicht mit
Prototypwerten implementiert.

1. **WebSocket-Optimierung:**
   - Dedizierte WebSocket-Connection für Combat
   - State-Synchronisation optimieren
   - Reconnect-Handling verbessern

2. **Animations & VFX:**
   - Attack-Animationen
   - Damage-Numbers
   - HP-Bar-Transitions
   - Victory/Defeat-Screens

## Testing

**Unit-Tests erforderlich für:**
- Damage-Berechnung
- Initiative-Sortierung
- State-Transitions
- Idempotency-Key-Validierung

**Integration-Tests erforderlich für:**
- PvE-Encounter-Trigger
- PvP-Challenge-Flow
- Round-Resolution-Workflow
- Team-Wipe-Handling

**E2E-Tests erforderlich für:**
- Vollständiger PvE-Kampf
- PvP-Challenge-Escape
- Combat-UI-Interaktionen
- WebSocket-Event-Handling

## Debugging

**Nützliche Endpoints:**
- `POST /api/v1/combat/:id/resolve` - Manuelles Auflösen (GM)
- `GET /health/ws` - WebSocket-Connection-Status
- Combat-Log in Frontend zeigt alle Aktionen

**Logs:**
```typescript
server.log.info(`Combat ${id} started`);
server.log.debug(`Combat WS message: ${message}`);
console.error(`Failed to escalate PvP challenge ${id}:`, err);
```

## Deployment Notes

1. Migration `0000_slow_kang.sql` enthält bereits alle Combat-Tabellen
2. WebSocket-Support muss in Production aktiviert sein
3. GPS-Accuracy-Buffer auf Production-Werten testen
4. Timer-Delays können via Env-Vars konfiguriert werden (optional)

---

**Status:** ✅ Vollständig implementiert (Epic 6)
**Letzte Aktualisierung:** 2026-09-08
