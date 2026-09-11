# Combat/GDD traceability

`Via_Romae_GDD_v0.17.pdf` is the authoritative source. This table exists to
prevent prototype values from re-entering the implementation; it is not a
second balance catalogue.

| GDD rule | Authoritative implementation | Verification |
| --- | --- | --- |
| 7.2: class HP/ATK/DEF/INIT = guard 120/8/14/8, cleric 90/7/9/10, sculptor 100/11/10/8, condottiere 100/14/8/12 | `modules/classes/class-rules.ts`, consumed by `player-stats.service.ts` | `class-rules.test.ts`, `class-service.test.ts` |
| 7.9: flat stats before percent stats; effective INIT snapshots each round | `player-stats.service.ts`, `combat.service.ts` | `class-rules.test.ts`, `combat-calculation.test.ts` |
| 7.9: initiative tie-break = four-slot rarity score, then one persisted random value | `combat-calculation.ts`, `combat_round_order` | `combat-calculation.test.ts` |
| 7.10: ATK multiplier, dealt modifier, DEF/(DEF+50), taken modifier, commercial final rounding, minimum one | `combat-calculation.ts` | `combat-calculation.test.ts` |
| 7.10/7.11: shield before HP; shield cap 50% maxHP | `combat.service.ts`, `combat-calculation.ts` | `combat-calculation.test.ts` |
| 7.11: DAMAGE_DEALT, DAMAGE_TAKEN and DEF_PERCENT caps -60%/+100% | `combat-calculation.ts`, `player-stats.service.ts` | `combat-calculation.test.ts` |
| 7.11: duration is inclusive; cleanse priority CONTROL, DAMAGE_TAKEN, DAMAGE_DEALT, DEF, INIT | `combat.service.ts`, `class-rules.ts` | `class-rules.test.ts` |
| 7.12: full out-of-combat regeneration in 900 seconds, only alive/in area/not in combat | `health-regeneration.service.ts` | `class-rules.test.ts` |
| 8.3/8.11: 15-second server deadline, replace until lock, deterministic timeout attack | `combat.service.ts`, `combat_action_submission` | `combat-action.static.test.mjs`, integration script |
| 8.10: the four class loadouts and all numerical effects/cooldowns | `packages/contracts/src/schemas/ability.ts` | `class-rules.test.ts` |
| 22.2-22.6: persisted state, round/deadline validation, restart recovery and persisted action order | `combat.service.ts`, `combat_instance` | typecheck and integration suite |
| 23: visibility 60m, attack/join 20m, warning 20s, escape >30m, protection 60min, fame 50/25 | `combat.service.ts`, `pvp_protection` | integration suite |
| 9.11: 3-5 consumable units and 0-3 eligible personal equipment items per defeated player | `combat.service.ts`, `pvp_loot_resolution` | integration suite |
| 24.10: -10 denarii/downed; wipe additionally -10% current denarii and -3% fame capped at 100 | `combat.service.ts` ledger finalization | integration suite |
| 25.4/25.5: Cannoniere 2160 HP/24 DEF/9 INIT; Nero 3240 HP/30 DEF/11 INIT | `boss.service.ts`, overridable by approved content data | integration suite |
| 26.4/26.8: no invented dynamic HP scaling or applause balance while those values remain open | `boss.service.ts` | contract/typecheck |

## Deliberately unresolved GDD decisions

GDD 26 explicitly leaves the global boss round architecture, dynamic HP
scaling, concrete phase definitions and applause success/failure balance open.
The implementation therefore does **not** invent multipliers for those fields.
They must be introduced only with an approved, versioned boss definition.
