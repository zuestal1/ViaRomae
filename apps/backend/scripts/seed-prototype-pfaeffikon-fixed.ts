#!/usr/bin/env tsx
/**
 * Seed Script für Pfäffikon Prototype (FIXED)
 *
 * Erstellt:
 * - Team mit echten UUIDs
 * - Accounts (PLAYER + GM) mit Access Code "test123"
 * - Players verknüpft mit Team
 * - WorldObjects aus GeoJSON (publishable = true)
 * - Quest PT-Q01 mit Steps
 */

import { db } from '../src/db/client.js';
import { accounts } from '../src/db/schema/account.js';
import { teams, players } from '../src/db/schema/player.js';
import { worldObjects } from '../src/db/schema/world.js';
import { questDefinitions, questSteps } from '../src/db/schema/quest.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { eq, sql } from 'drizzle-orm';
import { hashAccessCode } from '../src/modules/auth/auth.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// GeoJSON paths
const DOCKER_GEOJSON_PATH = '/app/data/prototype-gameobjects.geojson';
const LOCAL_GEOJSON_PATH = join(__dirname, '../../../docs/Via_Romae_Pfaeffikon_Prototype_GameObjects_v0.1 (1).geojson');
const GEOJSON_PATH = existsSync(DOCKER_GEOJSON_PATH) ? DOCKER_GEOJSON_PATH : LOCAL_GEOJSON_PATH;

// ── Deterministic UUIDs (stable across re-runs → ON CONFLICT works) ──────────
const IDS = {
  team:      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  account1:  '550e8400-e29b-41d4-a716-446655440001',
  account2:  '550e8400-e29b-41d4-a716-446655440002',
  accountGm: '550e8400-e29b-41d4-a716-446655440003',
  player1:   '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  player2:   '6ba7b811-9dad-11d1-80b4-00c04fd430c8',
};

interface GeoJSONFeature {
  type: string;
  geometry: {
    type: string;
    coordinates: number[] | number[][] | number[][][];
  };
  properties: Record<string, unknown>;
}

interface GeoJSONFeatureCollection {
  type: string;
  features: GeoJSONFeature[];
  metadata?: Record<string, unknown>;
}

async function seedPrototype() {
  console.log('🧪 Starting Pfäffikon Prototype Seeding (FIXED)...\n');

  // Generate unique bcrypt hashes per account (each player has their own code)
  console.log('🔑 Generating access code hashes...');
  const CODES = {
    player1: 'spieler1',
    player2: 'spieler2',
    gm:      'meister1',
  };
  const [hash1, hash2, hashGm] = await Promise.all([
    hashAccessCode(CODES.player1),
    hashAccessCode(CODES.player2),
    hashAccessCode(CODES.gm),
  ]);
  console.log('  ✓ Hashes generated\n');

  try {
    // ── 1. Team ───────────────────────────────────────────────────────────────
    console.log('👥 Creating prototype test team...');

    await db.insert(teams)
      .values({
        id: IDS.team,
        name: 'Pfäffikon Test Team',
        inventoryCapacity: 40,
      })
      .onConflictDoUpdate({
        target: teams.id,
        set: { name: 'Pfäffikon Test Team' },
      });

    console.log(`  ✓ Team: Pfäffikon Test Team (${IDS.team})`);

    // ── 2. Accounts ───────────────────────────────────────────────────────────
    console.log('\n🔐 Creating test accounts...');

    const testAccounts = [
      { id: IDS.account1,  username: 'prototyp_player1', role: 'PLAYER' as const, accessCodeHash: hash1,  code: CODES.player1 },
      { id: IDS.account2,  username: 'prototyp_player2', role: 'PLAYER' as const, accessCodeHash: hash2,  code: CODES.player2 },
      { id: IDS.accountGm, username: 'prototyp_gm',      role: 'GM'     as const, accessCodeHash: hashGm, code: CODES.gm      },
    ];

    for (const acc of testAccounts) {
      await db.insert(accounts)
        .values({
          id: acc.id,
          username: acc.username,
          accessCodeHash: acc.accessCodeHash,
          role: acc.role,
        })
        .onConflictDoUpdate({
          target: accounts.id,
          set: { accessCodeHash: acc.accessCodeHash },
        });
      console.log(`  ✓ ${acc.username} (${acc.role}) – Access Code: ${acc.code}`);
    }

    // ── 3. Players ────────────────────────────────────────────────────────────
    console.log('\n🎮 Creating test players...');

    const testPlayers = [
      { id: IDS.player1, accountId: IDS.account1, playerName: 'Spieler 1', playerClass: 'guard' as const, hp: 120 },
      { id: IDS.player2, accountId: IDS.account2, playerName: 'Spieler 2', playerClass: 'condottiere' as const, hp: 100 },
    ];

    for (const p of testPlayers) {
      await db.insert(players)
        .values({
          id:        p.id,
          accountId: p.accountId,
          teamId:    IDS.team,
          class:     p.playerClass,
          hpCurrent: p.hp,
          status:    'ACTIVE',
          playerName: p.playerName,
        })
        .onConflictDoUpdate({
          target: players.id,
          set: {
            teamId:    IDS.team,
            hpCurrent: p.hp,
            status:    'ACTIVE',
            playerName: p.playerName,
          },
        });
      console.log(`  ✓ ${p.playerName} (${p.playerClass})`);
    }

    // ── 4. WorldObjects aus GeoJSON ───────────────────────────────────────────
    console.log('\n🗺️  Loading WorldObjects from GeoJSON...');

    if (!existsSync(GEOJSON_PATH)) {
      console.warn(`⚠️  GeoJSON not found at: ${GEOJSON_PATH}`);
      console.warn('   Skipping WorldObject loading...');
    } else {
      const geojson: GeoJSONFeatureCollection = JSON.parse(readFileSync(GEOJSON_PATH, 'utf-8'));

      let loaded = 0;
      let skipped = 0;

      for (const feature of geojson.features) {
        const props = feature.properties;
        const featureType = props['feature_type'] as string;

        if (!['location_candidate', 'enemy_encounter', 'store_definition', 'revival_area', 'boss_encounter'].includes(featureType)) {
          skipped++;
          continue;
        }

        let lat: number, lng: number;
        if (feature.geometry.type === 'Point') {
          [lng, lat] = feature.geometry.coordinates as number[];
        } else if (feature.geometry.type === 'Polygon') {
          [lng, lat] = (feature.geometry.coordinates as number[][][])[0][0];
        } else {
          skipped++;
          continue;
        }

        let objectType: string;
        if (featureType === 'location_candidate') {
          const roles = (props['support_roles'] as string[]) || [];
          if (roles.includes('QUEST_PICKUP') || roles.includes('QUEST_OBJECTIVE'))  objectType = 'LOCATION';
          else if (roles.includes('UNIQUE_WORLD_ENEMY'))  objectType = 'ENEMY';
          else if (roles.includes('STORE_LOCATION'))      objectType = 'STORE';
          else if (roles.includes('REVIVE_POINT'))        objectType = 'SAFE_ZONE';
          else if (roles.includes('WORLD_BOSS_LOCATION')) objectType = 'BOSS';
          else                                            objectType = 'LOCATION';
        } else if (featureType === 'enemy_encounter')  objectType = 'ENEMY';
        else if (featureType === 'store_definition')   objectType = 'STORE';
        else if (featureType === 'revival_area')       objectType = 'SAFE_ZONE';
        else if (featureType === 'boss_encounter')     objectType = 'BOSS';
        else                                           objectType = 'LOCATION';

        const externalId = (
          props['candidate_id'] ||
          props['encounter_id'] ||
          props['store_id'] ||
          props['boss_event_id'] ||
          `proto-${loaded}`
        ) as string;

        const insertedId = externalId;
        
        await db.insert(worldObjects)
          .values({
            externalId,
            type:               objectType as 'LOCATION' | 'ENEMY' | 'STORE' | 'SAFE_ZONE' | 'BOSS' | 'NPC',
            name:               (props['name'] as string) || 'Unnamed Location',
            lat,
            lng,
            // geom will be set via raw SQL below
            interactionRadiusM: (props['standard_interaction_radius_m'] as number) || (props['interaction_radius_m'] as number) || 15,
            exitRadiusM:        (props['exit_radius_m'] as number) || 25,
            discoveryRadiusM:   (props['discovery_radius_m'] as number) || 55,
            aggroRadiusM:       (props['aggro_radius_m'] as number) || 20,
            publishable:        true, // Prototype objects must always be discoverable
            metadata: { featureType, day: props['day'] || 'PROTOTYPE', prototype: true, ...props },
          })
          .onConflictDoUpdate({
            target: worldObjects.externalId,
            set: {
              name:        (props['name'] as string) || 'Unnamed Location',
              lat,
              lng,
              publishable: true, // Ensure upgrade from false → true on re-run
              // ✅ FIX: Update PostGIS geom column so WorldObjects are discoverable
              geom:        sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`,
            },
          });

        // ✅ FIX: Set geom via raw SQL (Drizzle .values() doesn't support sql`` templates well)
        await db.execute(sql`
          UPDATE world_object
          SET geom = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)
          WHERE external_id = ${insertedId}
            AND geom IS NULL
        `);

        loaded++;
        console.log(`  ✓ ${(props['name'] as string) || externalId} (${objectType})`);
      }

      console.log(`\n  📦 Loaded ${loaded} WorldObjects (skipped ${skipped})`);
    }

    // ── 5. Quest PT-Q01 ───────────────────────────────────────────────────────
    console.log('\n📜 Creating Quest PT-Q01...');

    const [quest] = await db.insert(questDefinitions)
      .values({
        externalId: 'PT-Q01',
        title:      'Die drei Siegel der Schildwacht',
        type:       'REGULAR',
        day:        'PROTOTYPE',
        contentJson: JSON.stringify({
          story_conflict: 'Konrad prüft, ob das Team eine Schutzfolge erinnert, als Einheit drei Posten erreicht und den Schatten des Passetto besiegt.',
          quest_giver_name: 'Konrad von der letzten Schildwacht',
          reward: { glory: 55, denarii: 30 },
        }),
      })
      .onConflictDoUpdate({
        target: questDefinitions.externalId,
        set: { title: 'Die drei Siegel der Schildwacht' },
      })
      .returning();

    console.log(`  ✓ Quest: ${quest.title} (${quest.id})`);

    // ── 6. Quest Steps ────────────────────────────────────────────────────────
    console.log('\n📋 Creating Quest Steps...');

    const steps = [
      {
        stepId:         'PT-Q01-S01',
        sequence:       1,
        flowPhase:      'ACCEPT'    as const,
        stepActionType: 'REACH_LOCATION' as const,
        stepCategory:   'FLOW_ACTION',
        targetRef:      'place_pt_pfaeffikon_q1',
        required:       true,
      },
      {
        stepId:         'PT-Q01-S02',
        sequence:       2,
        flowPhase:      'OBJECTIVE' as const,
        stepActionType: 'REACH_LOCATION' as const,
        stepCategory:   'OBJECTIVE',
        targetRef:      'place_pt_pfaeffikon_q2',
        required:       true,
      },
      {
        stepId:         'PT-Q01-S03',
        sequence:       3,
        flowPhase:      'OBJECTIVE' as const,
        stepActionType: 'REACH_LOCATION' as const,
        stepCategory:   'OBJECTIVE',
        targetRef:      'place_pt_pfaeffikon_q3',
        required:       true,
      },
    ];

    for (const step of steps) {
      await db.insert(questSteps)
        .values({ questDefinitionId: quest.id, ...step })
        .onConflictDoNothing();
      console.log(`  ✓ Step ${step.sequence}: ${step.stepActionType} → ${step.targetRef}`);
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ Prototype Seeding abgeschlossen!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    console.log('🔐 Login-Zugangsdaten:');
    console.log('  Username: prototyp_player1  |  Access Code: spieler1');
    console.log('  Username: prototyp_player2  |  Access Code: spieler2');
    console.log('  Username: prototyp_gm       |  Access Code: meister1');
    console.log('');
    console.log('🌐 Zugang:');
    console.log('  Backend:  http://localhost:3001');
    console.log('  Frontend: http://localhost:5175');
    console.log('');
    console.log('📍 Erste Quest-Station (GPS simulieren):');
    console.log('  Lat: 47.3745502  Lng: 8.7949444');
    console.log('═══════════════════════════════════════════════════════════');

  } catch (error) {
    console.error('❌ Fehler beim Seeding:', error);
    throw error;
  }
}

seedPrototype()
  .then(() => { console.log('\n✨ Seeding erfolgreich abgeschlossen'); process.exit(0); })
  .catch((error) => { console.error('\n💥 Seeding fehlgeschlagen:', error); process.exit(1); });
