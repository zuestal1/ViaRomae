import { z } from "zod";

export const AbilityIdSchema = z.enum([
  "gardist.hellebardenstoss", "gardist.leibwache", "gardist.schildwall", "gardist.standhaft",
  "monastic.pilgerstab", "monastic.pilgersegen", "monastic.fuerbitte", "monastic.barmherzigkeit",
  "sculptor.meisselschlag", "sculptor.schwachstelle", "sculptor.marmorstaub", "sculptor.meisterliches_auge",
  "condottiere.klingenhieb", "condottiere.duell", "condottiere.finisher", "condottiere.blut_im_wasser",
]);
export type AbilityId = z.infer<typeof AbilityIdSchema>;

export const AbilityClassSchema = z.enum(["GARDIST", "MONASTIC", "SCULPTOR", "CONDOTTIERE"]);
export type AbilityClass = z.infer<typeof AbilityClassSchema>;
export const AbilityTargetTypeSchema = z.enum(["SELF", "ALLY", "ENEMY", "ALL_ACTIVE_ALLIES", "PASSIVE"]);
export type AbilityTargetType = z.infer<typeof AbilityTargetTypeSchema>;

export const AbilityConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ALWAYS") }),
  z.object({ kind: z.literal("TARGET_HP_AT_MOST_PERCENT"), percent: z.number() }),
  z.object({ kind: z.literal("CONTENT_CATEGORY"), categories: z.array(z.string()) }),
  z.object({ kind: z.literal("REVIVAL_ITEM_USED") }),
]);
export const AbilityEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("DAMAGE"), attackMultiplier: z.number(), threatBonusPercent: z.number().optional(), selfIncomingDamagePercent: z.number().optional() }),
  z.object({ kind: z.literal("BODYGUARD"), transferPercent: z.number() }),
  z.object({ kind: z.literal("TEAM_DAMAGE_REDUCTION"), percent: z.number() }),
  z.object({ kind: z.literal("INCOMING_DAMAGE_REDUCTION"), percent: z.number() }),
  z.object({ kind: z.literal("HEAL"), flat: z.number(), attackMultiplier: z.number(), beforeHealingModifiers: z.boolean() }),
  z.object({ kind: z.literal("CLEANSE_AND_SHIELD"), removableEffects: z.number(), priority: z.literal("GDD"), shield: z.number() }),
  z.object({ kind: z.literal("REVIVAL_HP_PERCENT"), percent: z.number() }),
  z.object({ kind: z.literal("DAMAGE_AND_DEFENSE_REDUCTION"), attackMultiplier: z.number(), defensePercent: z.number() }),
  z.object({ kind: z.literal("NEXT_ACTION_DAMAGE_REDUCTION"), percent: z.number() }),
  z.object({ kind: z.literal("CONTENT_BONUS"), bonuses: z.array(z.enum(["OPTIONAL_ANSWERS", "HINTS", "MODERATE_REWARDS"])) }),
  z.object({ kind: z.literal("DAMAGE_VS_LOW_HP"), percent: z.number(), thresholdPercent: z.number() }),
]);

export const AbilityDefinitionSchema = z.object({
  id: AbilityIdSchema,
  displayName: z.string(),
  class: AbilityClassSchema,
  description: z.string(),
  allowedTargetTypes: z.array(AbilityTargetTypeSchema).min(1),
  conditions: z.array(AbilityConditionSchema).min(1),
  effect: AbilityEffectSchema,
  duration: z.string(),
  cooldownRounds: z.number().int().nonnegative(),
  resolutionRule: z.string(),
  passive: z.boolean(),
});
export type AbilityDefinition = z.infer<typeof AbilityDefinitionSchema>;

const define = <T extends AbilityDefinition>(definition: T): T => definition;

/** Canonical GDD 8.10 data. Server and clients consume this same immutable catalogue. */
export const ABILITY_DEFINITIONS = Object.freeze({
  "gardist.hellebardenstoss": define({ id: "gardist.hellebardenstoss", displayName: "Hellebardenstoss", class: "GARDIST", description: "100 % ATK Schaden und 50 % zusätzliche Threat.", allowedTargetTypes: ["ENEMY"], conditions: [{ kind: "ALWAYS" }], effect: { kind: "DAMAGE", attackMultiplier: 1, threatBonusPercent: 50 }, duration: "Sofort", cooldownRounds: 0, resolutionRule: "Schaden und zusätzliche Threat werden bei der Aktion erzeugt.", passive: false }),
  "gardist.leibwache": define({ id: "gardist.leibwache", displayName: "Leibwache", class: "GARDIST", description: "Überträgt 60 % des auf ein gewähltes Teammitglied gerichteten Schadens auf den Gardisten.", allowedTargetTypes: ["ALLY"], conditions: [{ kind: "ALWAYS" }], effect: { kind: "BODYGUARD", transferPercent: 60 }, duration: "Bis zur nächsten eigenen Aktion", cooldownRounds: 2, resolutionRule: "Die Übertragung wird vor sonstiger Schadensreduktion des geschützten Ziels aufgeteilt.", passive: false }),
  "gardist.schildwall": define({ id: "gardist.schildwall", displayName: "Schildwall", class: "GARDIST", description: "Alle aktiven Teammitglieder erleiden 30 % weniger eingehenden Schaden.", allowedTargetTypes: ["ALL_ACTIVE_ALLIES"], conditions: [{ kind: "ALWAYS" }], effect: { kind: "TEAM_DAMAGE_REDUCTION", percent: 30 }, duration: "Eine gegnerische Runde", cooldownRounds: 3, resolutionRule: "Gilt ab Aktivierung bis zum Ende der nächsten vollständigen Gegnerphase; die Initiative des Gardisten verkürzt den Effekt nicht.", passive: false }),
  "gardist.standhaft": define({ id: "gardist.standhaft", displayName: "Standhaft", class: "GARDIST", description: "Dauerhaft 10 % weniger eingehender Schaden.", allowedTargetTypes: ["PASSIVE"], conditions: [{ kind: "ALWAYS" }], effect: { kind: "INCOMING_DAMAGE_REDUCTION", percent: 10 }, duration: "Dauerhaft", cooldownRounds: 0, resolutionRule: "Reduziert jeden eingehenden Schaden des Gardisten.", passive: true }),
  "monastic.pilgerstab": define({ id: "monastic.pilgerstab", displayName: "Pilgerstab", class: "MONASTIC", description: "100 % ATK Schaden.", allowedTargetTypes: ["ENEMY"], conditions: [{ kind: "ALWAYS" }], effect: { kind: "DAMAGE", attackMultiplier: 1 }, duration: "Sofort", cooldownRounds: 0, resolutionRule: "Verursacht bei Auflösung 100 % ATK Schaden.", passive: false }),
  "monastic.pilgersegen": define({ id: "monastic.pilgersegen", displayName: "Pilgersegen", class: "MONASTIC", description: "Heilt 20 + 1,5 × ATK vor Heilungsmodifikatoren.", allowedTargetTypes: ["SELF", "ALLY"], conditions: [{ kind: "ALWAYS" }], effect: { kind: "HEAL", flat: 20, attackMultiplier: 1.5, beforeHealingModifiers: true }, duration: "Sofort", cooldownRounds: 2, resolutionRule: "Grundheilung wird berechnet, danach greifen Heilungsmodifikatoren und maxHP.", passive: false }),
  "monastic.fuerbitte": define({ id: "monastic.fuerbitte", displayName: "Fürbitte", class: "MONASTIC", description: "Entfernt genau einen entfernbaren negativen Effekt nach GDD-Priorität und gibt 10 Shield.", allowedTargetTypes: ["SELF", "ALLY"], conditions: [{ kind: "ALWAYS" }], effect: { kind: "CLEANSE_AND_SHIELD", removableEffects: 1, priority: "GDD", shield: 10 }, duration: "Shield bis verbraucht", cooldownRounds: 3, resolutionRule: "Entfernt höchstens einen entfernbaren Effekt in GDD-Priorität, dann werden 10 Shield gewährt.", passive: false }),
  "monastic.barmherzigkeit": define({ id: "monastic.barmherzigkeit", displayName: "Barmherzigkeit", class: "MONASTIC", description: "Wiederbelebungsitems stellen 50 % statt 30 % maxHP wieder her.", allowedTargetTypes: ["PASSIVE"], conditions: [{ kind: "REVIVAL_ITEM_USED" }], effect: { kind: "REVIVAL_HP_PERCENT", percent: 50 }, duration: "Dauerhaft", cooldownRounds: 0, resolutionRule: "Ersetzt beim Einsatz eines Wiederbelebungsitems dessen 30-%-Wert durch 50 % maxHP.", passive: true }),
  "sculptor.meisselschlag": define({ id: "sculptor.meisselschlag", displayName: "Meisselschlag", class: "SCULPTOR", description: "100 % ATK Schaden.", allowedTargetTypes: ["ENEMY"], conditions: [{ kind: "ALWAYS" }], effect: { kind: "DAMAGE", attackMultiplier: 1 }, duration: "Sofort", cooldownRounds: 0, resolutionRule: "Verursacht bei Auflösung 100 % ATK Schaden.", passive: false }),
  "sculptor.schwachstelle": define({ id: "sculptor.schwachstelle", displayName: "Schwachstelle", class: "SCULPTOR", description: "70 % ATK Schaden und −25 % DEF.", allowedTargetTypes: ["ENEMY"], conditions: [{ kind: "ALWAYS" }], effect: { kind: "DAMAGE_AND_DEFENSE_REDUCTION", attackMultiplier: .7, defensePercent: 25 }, duration: "2 Runden", cooldownRounds: 2, resolutionRule: "Schaden wird zuerst verursacht; danach wird DEF für zwei Runden reduziert.", passive: false }),
  "sculptor.marmorstaub": define({ id: "sculptor.marmorstaub", displayName: "Marmorstaub", class: "SCULPTOR", description: "Die nächste Aktion des gewählten Gegners verursacht 35 % weniger Schaden.", allowedTargetTypes: ["ENEMY"], conditions: [{ kind: "ALWAYS" }], effect: { kind: "NEXT_ACTION_DAMAGE_REDUCTION", percent: 35 }, duration: "Nächste Aktion des Ziels", cooldownRounds: 3, resolutionRule: "Der Malus wird beim nächsten verursachten Schaden der nächsten Zielaktion verbraucht.", passive: false }),
  "sculptor.meisterliches_auge": define({ id: "sculptor.meisterliches_auge", displayName: "Meisterliches Auge", class: "SCULPTOR", description: "Optionale Antworten, Hinweise oder moderate Bonusbelohnungen bei passendem Kulturcontent.", allowedTargetTypes: ["PASSIVE"], conditions: [{ kind: "CONTENT_CATEGORY", categories: ["ART", "FOUNTAIN", "CHURCH", "STATUE", "ARCHITECTURE"] }], effect: { kind: "CONTENT_BONUS", bonuses: ["OPTIONAL_ANSWERS", "HINTS", "MODERATE_REWARDS"] }, duration: "Dauerhaft", cooldownRounds: 0, resolutionRule: "Content kann einen der moderaten optionalen Boni anbieten; kein automatischer Kampfeffekt.", passive: true }),
  "condottiere.klingenhieb": define({ id: "condottiere.klingenhieb", displayName: "Klingenhieb", class: "CONDOTTIERE", description: "100 % ATK Schaden.", allowedTargetTypes: ["ENEMY"], conditions: [{ kind: "ALWAYS" }], effect: { kind: "DAMAGE", attackMultiplier: 1 }, duration: "Sofort", cooldownRounds: 0, resolutionRule: "Verursacht bei Auflösung 100 % ATK Schaden.", passive: false }),
  "condottiere.duell": define({ id: "condottiere.duell", displayName: "Duell", class: "CONDOTTIERE", description: "160 % ATK Schaden; danach 15 % mehr eingehender Schaden.", allowedTargetTypes: ["ENEMY"], conditions: [{ kind: "ALWAYS" }], effect: { kind: "DAMAGE", attackMultiplier: 1.6, selfIncomingDamagePercent: 15 }, duration: "Bis zur nächsten eigenen Aktion", cooldownRounds: 2, resolutionRule: "Schaden wird verursacht und die Verwundbarkeit anschließend auf den Anwender gelegt.", passive: false }),
  "condottiere.finisher": define({ id: "condottiere.finisher", displayName: "Finisher", class: "CONDOTTIERE", description: "Gegen Ziele mit höchstens 30 % HP: 220 % ATK Schaden.", allowedTargetTypes: ["ENEMY"], conditions: [{ kind: "TARGET_HP_AT_MOST_PERCENT", percent: 30 }], effect: { kind: "DAMAGE", attackMultiplier: 2.2 }, duration: "Sofort", cooldownRounds: 3, resolutionRule: "Die HP-Bedingung wird bei Aktionsauflösung erneut geprüft; nur dann entsteht Schaden.", passive: false }),
  "condottiere.blut_im_wasser": define({ id: "condottiere.blut_im_wasser", displayName: "Blut im Wasser", class: "CONDOTTIERE", description: "15 % mehr verursachter Schaden gegen Ziele unter 30 % HP.", allowedTargetTypes: ["PASSIVE"], conditions: [{ kind: "TARGET_HP_AT_MOST_PERCENT", percent: 30 }], effect: { kind: "DAMAGE_VS_LOW_HP", percent: 15, thresholdPercent: 30 }, duration: "Dauerhaft", cooldownRounds: 0, resolutionRule: "Wird nach Auswahl der Schadensaktion anhand der Ziel-HP geprüft und auf deren Schaden angewendet.", passive: true }),
} satisfies Record<AbilityId, AbilityDefinition>);

export const CLASS_LOADOUTS: Readonly<Record<AbilityClass, readonly AbilityId[]>> = Object.freeze({
  GARDIST: ["gardist.hellebardenstoss", "gardist.leibwache", "gardist.schildwall", "gardist.standhaft"],
  MONASTIC: ["monastic.pilgerstab", "monastic.pilgersegen", "monastic.fuerbitte", "monastic.barmherzigkeit"],
  SCULPTOR: ["sculptor.meisselschlag", "sculptor.schwachstelle", "sculptor.marmorstaub", "sculptor.meisterliches_auge"],
  CONDOTTIERE: ["condottiere.klingenhieb", "condottiere.duell", "condottiere.finisher", "condottiere.blut_im_wasser"],
});
