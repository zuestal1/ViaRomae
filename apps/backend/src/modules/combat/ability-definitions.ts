import type { AbilityDefinition, PlayerClass } from "@jlw/contracts";

type ClassDefinition = {
  icon: string;
  stats: { atk: number; def: number; init: number };
  passive: { name: string; description: string; icon: string };
  abilities: AbilityDefinition[];
};

const attack = (icon: string): AbilityDefinition => ({
  id: "standardangriff", name: "Standardangriff", icon, kind: "STANDARD",
  description: "Fügt einem Gegner normalen Angriffsschaden zu.", targetType: "ENEMY",
  value: 10, valueLabel: "Schaden", cooldownRounds: 0, cooldownRemaining: 0,
});

export const CLASS_DEFINITIONS: Record<PlayerClass, ClassDefinition> = {
  GARDIST: { icon: "🛡️", stats: { atk: 12, def: 15, init: 7 }, passive: { name: "Standhaft", icon: "🏰", description: "Erhält 10 % weniger Schaden." }, abilities: [attack("⚔️"),
    { id: "schildschlag", name: "Schildschlag", icon: "💥", kind: "CLASS", description: "Schaden und Schutz für den Gardisten.", targetType: "ENEMY", value: 16, valueLabel: "Schaden", cooldownRounds: 2, cooldownRemaining: 0 },
    { id: "schutzwall", name: "Schutzwall", icon: "🛡️", kind: "CLASS", description: "Verleiht dem gesamten Team einen Schild.", targetType: "ALL_ALLIES", value: 12, valueLabel: "Schild", cooldownRounds: 3, cooldownRemaining: 0 }] },
  MÖNCH: { icon: "🙏", stats: { atk: 8, def: 10, init: 10 }, passive: { name: "Innere Ruhe", icon: "☯️", description: "Heilung ist um 10 % verstärkt." }, abilities: [attack("👊"),
    { id: "heilgebet", name: "Heilgebet", icon: "✨", kind: "CLASS", description: "Heilt ein Teammitglied.", targetType: "ALLY", value: 22, valueLabel: "Heilung", cooldownRounds: 2, cooldownRemaining: 0 },
    { id: "letzte-hilfe", name: "Letzte Hilfe", icon: "💚", kind: "CLASS", description: "Starke Selbstheilung bei niedrigen HP.", targetType: "SELF", value: 35, valueLabel: "Heilung", cooldownRounds: 4, cooldownRemaining: 0, condition: { type: "HP_BELOW_PERCENT", value: 40, description: "Nur unter 40 % HP" } }] },
  HÄNDLER: { icon: "💰", stats: { atk: 9, def: 9, init: 11 }, passive: { name: "Gute Beziehungen", icon: "🤝", description: "Items wirken 10 % stärker." }, abilities: [attack("🗡️"),
    { id: "bestechung", name: "Bestechung", icon: "🪙", kind: "CLASS", description: "Schwächt einen Gegner.", targetType: "ENEMY", value: 20, valueLabel: "Schwächung", cooldownRounds: 2, cooldownRemaining: 0 },
    { id: "versorgung", name: "Versorgung", icon: "📦", kind: "CLASS", description: "Stärkt alle Teammitglieder.", targetType: "ALL_ALLIES", value: 10, valueLabel: "Stärkung", cooldownRounds: 3, cooldownRemaining: 0 }] },
  SPÄHER: { icon: "🏹", stats: { atk: 14, def: 7, init: 15 }, passive: { name: "Adlerauge", icon: "🦅", description: "Erhöhte kritische Trefferchance." }, abilities: [attack("🏹"),
    { id: "praezisionsschuss", name: "Präzisionsschuss", icon: "🎯", kind: "CLASS", description: "Ein besonders starker Schuss auf einen Gegner.", targetType: "ENEMY", value: 24, valueLabel: "Schaden", cooldownRounds: 2, cooldownRemaining: 0 },
    { id: "pfeilhagel", name: "Pfeilhagel", icon: "🌧️", kind: "CLASS", description: "Trifft alle Gegner.", targetType: "ALL_ENEMIES", value: 12, valueLabel: "Schaden je Ziel", cooldownRounds: 3, cooldownRemaining: 0 }] },
  MAGIER: { icon: "🔮", stats: { atk: 16, def: 6, init: 9 }, passive: { name: "Arkaner Fluss", icon: "🌌", description: "Der erste Cooldown jeder Begegnung ist verkürzt." }, abilities: [attack("✨"),
    { id: "feuerball", name: "Feuerball", icon: "🔥", kind: "CLASS", description: "Hoher magischer Schaden gegen einen Gegner.", targetType: "ENEMY", value: 26, valueLabel: "Schaden", cooldownRounds: 2, cooldownRemaining: 0 },
    { id: "arkane-welle", name: "Arkane Welle", icon: "🌊", kind: "CLASS", description: "Magischer Schaden gegen alle Gegner.", targetType: "ALL_ENEMIES", value: 14, valueLabel: "Schaden je Ziel", cooldownRounds: 3, cooldownRemaining: 0 }] },
};
