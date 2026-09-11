# GDD-konformes Klassensystem

`Via_Romae_GDD_v0.17.pdf` ist die verbindliche Quelle für alle Klassenwerte und
-mechaniken. Werte dürfen weder im Frontend noch in einem zweiten Kampf-Katalog
abweichend neu definiert werden.

## Kanonische Klassen

| ID | Anzeige | maxHP | ATK | DEF | INIT |
| --- | --- | ---: | ---: | ---: | ---: |
| `guard` | Schweizer Gardist | 120 | 8 | 14 | 8 |
| `cleric` | Nonne / Mönch | 90 | 7 | 9 | 10 |
| `sculptor` | Bildhauer | 100 | 11 | 10 | 8 |
| `condottiere` | Condottiere | 100 | 14 | 8 | 12 |

Die technischen IDs kommen aus `PlayerClassSchema`. `CLASSES` enthält die
serverautoritiven Basiswerte. `ABILITY_DEFINITIONS` enthält die Mechaniken aus
GDD 8.10. Das Frontend darf nur diese Verträge beziehungsweise API-Antworten
anzeigen. Insbesondere sind frühere Prototypklassen keine spielbaren Klassen.

„Eine gegnerische Runde“ beim **Schildwall** bezeichnet eine Effekt-Lebensdauer
ab Aktivierung bis zum Ende der nächsten vollständigen Gegnerphase. Die nach der
Aktivierung noch verbleibenden Initiativaktionen zählen nicht als vollständige
Phase. Der Schutz bleibt daher durch den Rundenwechsel bestehen und endet erst,
nachdem in der Folgerunde alle Gegner gehandelt haben. Diese Auslegung gilt
einheitlich für PvE-, PvP- und Bosskämpfe.

## Invarianten

- Genau vier Klassen und höchstens eine bestätigte Belegung je Team.
- Eine bestätigte Wahl ist für Spieler permanent; GM-Korrekturen sind begründet
  und auditiert.
- Jede Bestätigung vergibt idempotent die gebundene N-Startwaffe der Klasse.
- Flache Boni werden vor prozentualen Boni verrechnet; Prozentwerte sind auf
  −60 bis +100 Prozent begrenzt.
- Der Gardist wird in Spieleroberflächen mit einem Schild dargestellt.
- Finisher gilt bei höchstens 30 Prozent Ziel-HP; Blut im Wasser nur darunter.
- Wiederbelebung stellt regulär 30 Prozent, beim Kleriker 50 Prozent maxHP her.
- Eine Runde hat ein 15-Sekunden-Aktionsfenster; Regeneration auf volle HP dauert
  außerhalb des Kampfs und innerhalb des Spielgebiets 900 Sekunden.

## Integrationsprüfung der zusammengeführten Änderungen

Die innerhalb des dreistündigen Integrationsfensters zusammengeführten Arbeiten
zu Klassen-IDs, Stats, Klassenwahl, Fähigkeiten, Effekten/Cooldowns, Ausrüstung,
Ruhm, Quest-Gating, Kampfberechnung und Charakter-UI wurden auf einen gemeinsamen
Vertrag zurückgeführt. TypeScript-Typecheck, Tests und Workspace-Build bilden die
verbindliche Integrationsprüfung nach weiteren Änderungen.
