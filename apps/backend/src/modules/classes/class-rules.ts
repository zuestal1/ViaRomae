import type { ClassId } from "@jlw/contracts";

export const SLOTS = ["WEAPON", "CLOTHING", "DEFENSE", "ARTIFACT"] as const;
export const STARTER_WEAPONS = {
  guard: { id: "starter_halberd", slot: "WEAPON", rarity: "N", bound: true, classId: "guard" },
  cleric: { id: "starter_pilgrim_staff", slot: "WEAPON", rarity: "N", bound: true, classId: "cleric" },
  sculptor: { id: "starter_chisel_hammer", slot: "WEAPON", rarity: "N", bound: true, classId: "sculptor" },
  condottiere: { id: "starter_side_sword", slot: "WEAPON", rarity: "N", bound: true, classId: "condottiere" },
} as const;
export const ROUND_LOCK_MS = 15_000;
export const REGEN_SECONDS = 900;
export const STAT_PERCENT_CAP = { min: -0.6, max: 1 } as const;

export const CLASSES = {
  guard: { id: "guard", name: "Schweizer Gardist", aliases: [], baseStats: { maxHP: 120, atk: 8, def: 14, initiative: 8 }, abilities: [
    { id: "halberd_thrust", name: "Hellebardenstoss", kind: "BASIC", targets: ["ENEMY"], cooldownRounds: 0, multiplier: 1, threatMultiplier: 1.5 },
    { id: "bodyguard", name: "Leibwache", kind: "ACTIVE", targets: ["ALLY"], cooldownRounds: 2, redirect: .6, duration: "UNTIL_NEXT_OWN_ACTION" },
    { id: "shield_wall", name: "Schildwall", kind: "ACTIVE", targets: ["ALL_ACTIVE_ALLIES"], cooldownRounds: 3, damageTakenPercent: -.3, durationRounds: 1 },
    { id: "steadfast", name: "Standhaft", kind: "PASSIVE", targets: ["SELF"], cooldownRounds: 0, damageTakenPercent: -.1 },
  ]},
  cleric: { id: "cleric", name: "Nonne / Mönch", aliases: ["Nonne", "Mönch"], baseStats: { maxHP: 90, atk: 7, def: 9, initiative: 10 }, abilities: [
    { id: "pilgrim_staff", name: "Pilgerstab", kind: "BASIC", targets: ["ENEMY"], cooldownRounds: 0, multiplier: 1 },
    { id: "pilgrim_blessing", name: "Pilgersegen", kind: "ACTIVE", targets: ["SELF", "ALLY"], cooldownRounds: 2, healBase: 20, healAtkMultiplier: 1.5 },
    { id: "intercession", name: "Fürbitte", kind: "ACTIVE", targets: ["SELF", "ALLY"], cooldownRounds: 3, dispels: 1, shield: 10 },
    { id: "mercy", name: "Barmherzigkeit", kind: "PASSIVE", targets: ["SELF"], cooldownRounds: 0, revivePercent: .5 },
  ]},
  sculptor: { id: "sculptor", name: "Bildhauer", aliases: [], baseStats: { maxHP: 100, atk: 11, def: 10, initiative: 8 }, abilities: [
    { id: "chisel_strike", name: "Meisselschlag", kind: "BASIC", targets: ["ENEMY"], cooldownRounds: 0, multiplier: 1 },
    { id: "weak_spot", name: "Schwachstelle", kind: "ACTIVE", targets: ["ENEMY"], cooldownRounds: 2, multiplier: .7, defPercent: -.25, durationRounds: 2 },
    { id: "marble_dust", name: "Marmorstaub", kind: "ACTIVE", targets: ["ENEMY"], cooldownRounds: 3, damageDealtPercent: -.35, remainingTriggers: 1 },
    { id: "masterful_eye", name: "Meisterliches Auge", kind: "PASSIVE", targets: ["SELF"], cooldownRounds: 0, optionalContentTags: ["ART", "FOUNTAIN", "CHURCH", "STATUE", "ARCHITECTURE"] },
  ]},
  condottiere: { id: "condottiere", name: "Condottiere", aliases: [], baseStats: { maxHP: 100, atk: 14, def: 8, initiative: 12 }, abilities: [
    { id: "blade_slash", name: "Klingenhieb", kind: "BASIC", targets: ["ENEMY"], cooldownRounds: 0, multiplier: 1 },
    { id: "duel", name: "Duell", kind: "ACTIVE", targets: ["ENEMY"], cooldownRounds: 2, multiplier: 1.6, selfDamageTakenPercent: .15, duration: "UNTIL_NEXT_OWN_ACTION" },
    { id: "finisher", name: "Finisher", kind: "ACTIVE", targets: ["ENEMY"], cooldownRounds: 3, multiplier: 2.2, maxTargetHpRatio: .3 },
    { id: "blood_in_water", name: "Blut im Wasser", kind: "PASSIVE", targets: ["ENEMY"], cooldownRounds: 0, damageDealtPercent: .15, maxTargetHpRatioExclusive: .3 },
  ]},
} as const;

export type Stats = { maxHP: number; atk: number; def: number; initiative: number };
export function deriveStats(classId: ClassId, equipment: Partial<Stats> = {}, fameHP = 0, permanent: Partial<Stats> = {}, temporary: Partial<Stats> = {}, percentages: Partial<Record<keyof Stats, number>> = {}): Stats {
  const base = CLASSES[classId].baseStats;
  const value = (key: keyof Stats) => (base[key] + (equipment[key] ?? 0) + (permanent[key] ?? 0) + (temporary[key] ?? 0) + (key === "maxHP" ? fameHP : 0)) * (1 + Math.max(STAT_PERCENT_CAP.min, Math.min(STAT_PERCENT_CAP.max, percentages[key] ?? 0)));
  return { maxHP: value("maxHP"), atk: value("atk"), def: value("def"), initiative: value("initiative") };
}
export const commercialRound = (n: number) => Math.floor(n + .5);
export function damage(atk: number, multiplier: number, def: number, dealt = 0, taken = 0): number {
  dealt = Math.max(-.6, Math.min(1, dealt)); taken = Math.max(-.6, Math.min(1, taken));
  return Math.max(1, commercialRound(atk * multiplier * (1 + dealt) * (1 - def / (def + 50)) * (1 + taken)));
}
export function healing(atk: number, missingHP: number, modifier = 0): number { return Math.min(missingHP, commercialRound((20 + 1.5 * atk) * (1 + modifier))); }
export const addShield = (current: number, amount: number, maxHP: number) => Math.min(current + amount, maxHP * .5);
export const effectExpiry = (appliedRound: number, durationRounds: number) => appliedRound + durationRounds - 1;
export type Debuff = { id: string; tags: string[]; removable: boolean; appliedRound: number };
const DISPEL_PRIORITY = ["CONTROL", "DAMAGE_TAKEN", "DAMAGE_DEALT", "DEF", "INIT"];
export function intercessionTarget(effects: Debuff[]): Debuff | undefined { return effects.filter(e => e.removable).sort((a,b) => { const pa=Math.min(...a.tags.map(t=>{const i=DISPEL_PRIORITY.indexOf(t); return i<0?99:i})); const pb=Math.min(...b.tags.map(t=>{const i=DISPEL_PRIORITY.indexOf(t); return i<0?99:i})); return pa-pb || a.appliedRound-b.appliedRound; })[0]; }
export function stackEffect<T extends { id: string; magnitude: number; stacks: number }>(effects: T[], next: T, policy: "NONE"|"REFRESH"|"REPLACE_STRONGER"|"STACK", maxStacks=1): T[] { const i=effects.findIndex(e=>e.id===next.id); if(i<0)return [...effects,next]; if(policy==="NONE")return effects; const copy=[...effects]; if(policy==="STACK")copy[i]={...next,stacks:Math.min(maxStacks,effects[i]!.stacks+next.stacks)}; else if(policy==="REFRESH" || next.magnitude>effects[i]!.magnitude)copy[i]=next; return copy; }
export function regen(current: number, max: number, elapsedSeconds: number, state: { alive: boolean; activeCombat: boolean; insidePlayArea: boolean }): number { if(!state.alive||state.activeCombat||!state.insidePlayArea)return current; return Math.min(max,current+max/REGEN_SECONDS*elapsedSeconds); }
export const defaultTarget = <T extends { id:string; alive:boolean }>(targets:T[], lastId?:string) => targets.find(t=>t.id===lastId&&t.alive) ?? targets.find(t=>t.alive);
export const isFinisherAvailable = (current:number,max:number) => current/max <= .3;
export const bloodInWaterApplies = (current:number,max:number) => current/max < .3;
export const reviveHP = (maxHP:number, classId:ClassId) => commercialRound(maxHP*(classId==="cleric"?.5:.3));
export const classOptionVisible = (required:ClassId, present:{classId:ClassId;alive:boolean;spatiallyValid:boolean}[]) => present.some(p=>p.classId===required&&p.alive&&p.spatiallyValid);

export const FAME_TIERS = [
  { id:"N", threshold:0, denarii:0, hp:0 }, { id:"R", threshold:500, denarii:40, hp:1 },
  { id:"SR", threshold:1000, denarii:60, hp:2 }, { id:"SSR", threshold:1800, denarii:80, hp:3 },
  { id:"E", threshold:2800, denarii:110, hp:4 }, { id:"L", threshold:4000, denarii:150, hp:5 },
] as const;
export function fameRewards(fame:number, highestIndex=0) { const reached=FAME_TIERS.reduce((n,t,i)=>fame>=t.threshold?i:n,0); const rewards=FAME_TIERS.slice(highestIndex+1,reached+1); return { highestIndex:Math.max(highestIndex,reached), denarii:rewards.reduce((n,t)=>n+t.denarii,0), hp: FAME_TIERS.slice(1,Math.max(highestIndex,reached)+1).reduce((n,t)=>n+t.hp,0), newlyReached:rewards.map(t=>t.id) }; }
