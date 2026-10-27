// Migrationen 20261102180000_maaned1_rettelser2.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). En stub af firmaer med de
// kolonner, migrationen bruger, og 20261102150000's RIGTIGE
// firma_kort_laas_fejl/firma_kort_laas_opgivet (så md5-drift-tjekket kører mod
// det rigtige). Migrationen køres TO gange (idempotent). Testes:
//   - kun kort: alarmen gives præcis én gang, når forsoeg >= 3 - også når
//     tælleren springer over 3 (samtidige kald), og igen for et nyt abonnement,
//   - introrabat, der venter: intro_planlagt_kl sættes/nulstilles af
//     triggeren, og firma_intro_venter_alarm giver én alarm pr. aftale efter
//     30 minutter,
//   - drift-tjekket afviser en ændret funktion.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { funktion, MIG } from "./prismodelStub";

const MIGRATION = readFileSync(path.join(MIG, "20261102180000_maaned1_rettelser2.sql"), "utf8");
const FORRIGE = "20261102150000_maaned1_rettelser.sql";

const F1 = "00000000-0000-4000-8000-00000000f181";
const F2 = "00000000-0000-4000-8000-00000000f182";

const STUB = `
create role anon; create role authenticated; create role service_role;
create table public.firmaer (
  id uuid primary key,
  stripe_subscription_id text,
  intro_status text,
  intro_noegle text,
  opdateret_kl timestamptz not null default now(),
  kort_laas_fejl_sub text,
  kort_laas_forsoeg integer not null default 0
);
insert into public.firmaer (id, stripe_subscription_id) values ('${F1}', 'sub_1'), ('${F2}', 'sub_2');
`;

let db: PGlite;

async function nyDatabase(): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(STUB);
  await d.exec(funktion(FORRIGE, "create or replace function public.firma_kort_laas_fejl("));
  await d.exec(funktion(FORRIGE, "create or replace function public.firma_kort_laas_opgivet("));
  return d;
}

async function fejl(sub: string, firma = F1): Promise<{ forsoeg: number; opgivet: boolean; alarm: boolean }> {
  const r = await db.query<{ j: { forsoeg: number; opgivet: boolean; alarm: boolean } }>(
    `select public.firma_kort_laas_fejl($1, $2) j`,
    [firma, sub],
  );
  return r.rows[0].j;
}

async function introAlarm(firma: string): Promise<{ alarm: boolean; ventet_min?: number }> {
  const r = await db.query<{ j: { alarm: boolean; ventet_min?: number } }>(`select public.firma_intro_venter_alarm($1, 30) j`, [firma]);
  return r.rows[0].j;
}

async function planlagtKl(firma: string): Promise<string | null> {
  const r = await db.query<{ kl: string | null }>(`select intro_planlagt_kl::text kl from public.firmaer where id = $1`, [firma]);
  return r.rows[0].kl;
}

describe("måned 1-rettelser 2 (20261102180000)", () => {
  beforeAll(async () => {
    db = await nyDatabase();
    // Et abonnement, der allerede er opgivet efter 150000 (alarm givet ved 3).
    await db.exec(`update public.firmaer set kort_laas_fejl_sub = 'sub_2', kort_laas_forsoeg = 3 where id = '${F2}'`);
    // En planlagt introrabat fra før migrationen.
    await db.exec(`update public.firmaer set intro_status = 'planlagt', intro_noegle = 'n0', opdateret_kl = now() - interval '2 hours' where id = '${F2}'`);
    await db.exec(MIGRATION);
    // Idempotent: anden kørsel ændrer intet og fejler ikke.
    await db.exec(MIGRATION);
  });

  describe("kun kort: alarm ved forsoeg >= 3, præcis én gang", () => {
    it("1. og 2. fejl: ingen alarm; 3.: alarm; 4. og 5.: ingen", async () => {
      expect(await fejl("sub_1")).toMatchObject({ forsoeg: 1, opgivet: false, alarm: false });
      expect(await fejl("sub_1")).toMatchObject({ forsoeg: 2, opgivet: false, alarm: false });
      expect(await fejl("sub_1")).toMatchObject({ forsoeg: 3, opgivet: true, alarm: true });
      expect(await fejl("sub_1")).toMatchObject({ forsoeg: 4, opgivet: true, alarm: false });
      expect(await fejl("sub_1")).toMatchObject({ forsoeg: 5, opgivet: true, alarm: false });
    });
    it("springer tælleren over 3 uden alarm (samtidige kald), gives den ved næste", async () => {
      // Som hvis kaldet, der fik 3, aldrig nåede at registrere alarmen.
      await db.exec(`update public.firmaer set stripe_subscription_id = 'sub_1b', kort_laas_fejl_sub = 'sub_1b',
                            kort_laas_forsoeg = 3, kort_laas_alarm_sub = null where id = '${F1}'`);
      expect(await fejl("sub_1b")).toMatchObject({ forsoeg: 4, opgivet: true, alarm: true });
      expect(await fejl("sub_1b")).toMatchObject({ forsoeg: 5, alarm: false });
    });
    it("et nyt abonnement tælles forfra og kan få sin egen alarm", async () => {
      await db.exec(`update public.firmaer set stripe_subscription_id = 'sub_1c' where id = '${F1}'`);
      expect(await fejl("sub_1c")).toMatchObject({ forsoeg: 1, alarm: false });
      expect(await fejl("sub_1c")).toMatchObject({ forsoeg: 2, alarm: false });
      expect(await fejl("sub_1c")).toMatchObject({ forsoeg: 3, alarm: true });
    });
    it("allerede opgivet før migrationen: ingen ny alarm", async () => {
      expect(await fejl("sub_2", F2)).toMatchObject({ forsoeg: 4, opgivet: true, alarm: false });
    });
    it("forkert abonnement: ikke_fundet", async () => {
      const r = await db.query<{ j: { kode: string } }>(`select public.firma_kort_laas_fejl($1, 'sub_x') j`, [F1]);
      expect(r.rows[0].j.kode).toBe("ikke_fundet");
    });
  });

  describe("introrabat, der venter", () => {
    it("eksisterende planlagt aftale får opdateret_kl som starttid", async () => {
      expect(await planlagtKl(F2)).not.toBeNull();
    });
    it("én alarm pr. aftale efter 30 minutter", async () => {
      const a = await introAlarm(F2);
      expect(a.alarm).toBe(true);
      expect(a.ventet_min).toBeGreaterThanOrEqual(119);
      expect((await introAlarm(F2)).alarm).toBe(false);
    });
    it("ny aftale (ny nøgle) starter forfra: ingen alarm før 30 minutter", async () => {
      await db.exec(`update public.firmaer set intro_noegle = 'n1' where id = '${F2}'`);
      const kl = await planlagtKl(F2);
      expect(kl).not.toBeNull();
      expect((await introAlarm(F2)).alarm).toBe(false);
      await db.exec(`update public.firmaer set intro_planlagt_kl = now() - interval '31 minutes' where id = '${F2}'`);
      expect((await introAlarm(F2)).alarm).toBe(true);
      expect((await introAlarm(F2)).alarm).toBe(false);
    });
    it("sat på (aktiv): starttiden nulstilles, og der gives ingen alarm", async () => {
      await db.exec(`update public.firmaer set intro_status = 'aktiv' where id = '${F2}'`);
      expect(await planlagtKl(F2)).toBeNull();
      expect((await introAlarm(F2)).alarm).toBe(false);
    });
    it("ny planlagt aftale på et firma uden: starttid sættes nu", async () => {
      await db.exec(`update public.firmaer set intro_status = 'planlagt', intro_noegle = 'm1' where id = '${F1}'`);
      expect(await planlagtKl(F1)).not.toBeNull();
      expect((await introAlarm(F1)).alarm).toBe(false);
    });
    it("rettigheder: kun service_role", async () => {
      const r = await db.query<{ anon: boolean; auth: boolean; sr: boolean }>(
        `select has_function_privilege('anon', 'public.firma_intro_venter_alarm(uuid,integer)', 'execute') anon,
                has_function_privilege('authenticated', 'public.firma_intro_venter_alarm(uuid,integer)', 'execute') auth,
                has_function_privilege('service_role', 'public.firma_intro_venter_alarm(uuid,integer)', 'execute') sr`,
      );
      expect(r.rows[0]).toEqual({ anon: false, auth: false, sr: true });
    });
  });

  it("drift-tjek: en ændret firma_kort_laas_fejl afbryder migrationen", async () => {
    const d = await nyDatabase();
    await d.exec(`create or replace function public.firma_kort_laas_fejl(p_firma uuid, p_subscription_id text)
                  returns jsonb language sql as $$ select '{}'::jsonb $$`);
    await expect(d.exec(MIGRATION)).rejects.toThrow(/md5/);
    await d.close();
  });
});
