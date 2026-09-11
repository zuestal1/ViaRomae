# Freigabeübersicht der Questinhalte

Stand: 11. September 2026

## Prüfergebnis der Arbeitsmappe

Die statusführenden, implementierungsrelevanten Inhalte in `Via_Romae_Questgruppierung_v0.10 (1).xlsx` sind vollständig freigegeben: 40 Questdefinitionen und ihre 40 Asset-Status, 36 Charaktere, 112 Rätsel, 35 Kampfprofile, 12 Unique-Gegner, 6 Timer, 5 Stores, 172 Asset-Prompts und 40 Stances tragen jeweils `APPROVED`.

Die 40 Questdefinitionen in der Arbeitsmappe wurden mit den 40 Questdefinitionen im GeoJSON abgeglichen. Im Haupt-GeoJSON tragen nach der Synchronisierung alle 152 Features den `content_status` `APPROVED`. Unabhängige Feld-, Geometrie- und Zugänglichkeitsprüfungen bleiben davon unberührt.

## Approved Questinhalte

| Tag | Typ | Quest-ID | Titel |
|---|---|---|---|
| BOTH_DAYS | MEDIA_LANGZEIT | M-LT-01 | Roma in zwölf Bildern |
| DAY_1 | HIDDEN | H-D1-01 | Die Schildkröten wachen |
| DAY_1 | HIDDEN | H-D1-02 | Ratte des Aquädukts |
| DAY_1 | HIDDEN | H-D1-03 | Die Satirelli |
| DAY_1 | MEDIA_LOCAL | M-D1-01 | Foto mit Schweizer Gardist |
| DAY_1 | MEDIA_LOCAL | M-D1-02 | Wie ein Engel |
| DAY_1 | MEDIA_LOCAL | M-D1-03 | Drei Brunnen, drei Figuren |
| DAY_1 | REGULAER | D1-Q01 | Der Fluchtkorridor |
| DAY_1 | REGULAER | D1-Q02 | Tore des Borgo |
| DAY_1 | REGULAER | D1-Q03 | Der Dreizack |
| DAY_1 | REGULAER | D1-Q04 | Antinoos über Rom |
| DAY_1 | REGULAER | D1-Q05 | Die steinerne Barke |
| DAY_1 | REGULAER | D1-Q06 | Berninis Werkstatt |
| DAY_1 | REGULAER | D1-Q07 | Agrippas Zeichen |
| DAY_1 | REGULAER | D1-Q08 | Kaiserbotschaften |
| DAY_1 | REGULAER | D1-Q09 | Das gebändigte Wasser |
| DAY_1 | REGULAER | D1-Q10 | Macht auf dem Quirinal |
| DAY_1 | REGULAER | D1-Q11 | Zeichen der Unbefleckten |
| DAY_1 | REGULAER | D1-Q12 | Stimmen der Republik |
| DAY_1 | REGULAER | D1-Q13 | Roms große Bühne |
| DAY_1 | REGULAER | D1-Q14 | Die steinerne Insel |
| DAY_1 | REGULAER | D1-Q15 | Cecilias Stimmen |
| DAY_1 | REGULAER | D1-Q16 | Republik auf dem Gianicolo |
| DAY_1 | WORLD_BOSS | B-D1-01 | Il Cannoniere del Gianicolo |
| DAY_2 | HIDDEN | H-D2-01 | Wächter der Porta Magica |
| DAY_2 | HIDDEN | H-D2-02 | Dantes Windrose |
| DAY_2 | MEDIA_LOCAL | M-D2-01 | Streitwagenrennen |
| DAY_2 | MEDIA_LOCAL | M-D2-02 | Gladiatorenkampf |
| DAY_2 | MEDIA_LOCAL | M-D2-03 | Souvenirreview |
| DAY_2 | REGULAER | D2-Q01 | Stern des Kapitols |
| DAY_2 | REGULAER | D2-Q02 | Quadrigen der Einheit |
| DAY_2 | REGULAER | D2-Q03 | Arena und Triumph |
| DAY_2 | REGULAER | D2-Q04 | Handel, Götter und Wahrheit |
| DAY_2 | REGULAER | D2-Q05 | Masken über dem Circus |
| DAY_2 | REGULAER | D2-Q06 | Das steinerne Schiff |
| DAY_2 | REGULAER | D2-Q07 | Sitz der Kirche |
| DAY_2 | REGULAER | D2-Q08 | Tore der Aurelianischen Mauer |
| DAY_2 | REGULAER | D2-Q09 | Schichten des Esquilino |
| DAY_2 | REGULAER | D2-Q10 | Wasser über dem Tor |
| DAY_2 | WORLD_BOSS | B-D2-01 | Custode della Neve |

## Noch nicht approved

- Questdefinitionen: **0**
- Sonstige Features mit einem von `APPROVED` abweichenden `content_status`: **0**

## GeoJSON-Abdeckung nach Feature-Typ

| Feature-Typ | Approved |
|---|---:|
| enemy_encounter | 12 |
| location_candidate | 90 |
| navigation_challenge | 4 |
| quest_definition | 40 |
| quest_timer | 6 |

| **Gesamt** | **152** |

## Abgrenzung

Die separate Datei `Via_Romae_Pfaeffikon_Prototype_GameObjects_v0.1 (1).geojson` beschreibt einen technischen Feldprototyp mit dem Status `PLAYTEST_READY`. Sie ist nicht die GeoJSON-Repräsentation der 40 in der Arbeitsmappe freigegebenen Rom-Quests und wurde deshalb nicht in eine Produktionsfreigabe umgedeutet.
