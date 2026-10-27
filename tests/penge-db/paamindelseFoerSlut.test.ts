// Migrationen 20261102250000_paamindelse_foer_slut.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). Stubs af auctions, bids,
// favorites, users, notifikation_indstillinger og notifikation_afsendelser med
// de kolonner, migrationen bruger. Migrationen køres TO gange (idempotent).
// Testes:
//   - idempotens: anden kørsel claimer intet, heller ikke efter en
//     forlængelse ved sene bud,
//   - filtrering: sælgeren, annullerede, pausede, skjulte, kunst-afventende,
//     uden for vinduet, slettede konti, typen slået helt fra og den gamle
//     favorit-nøgle,
//   - fører / fører ikke / kun favorit, og at en bruger med både bud og
//     favorit kun får én,
//   - kun service_role må kalde funktionen.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const MIG = path.resolve(import.meta.dirname, "../../supabase/migrations");
const MIGRATION = readFileSync(path.join(MIG, "20261102250000_paamindelse_foer_slut.sql"), "utf8");

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SAELGER = id(1);
const A = id(11); // byder, fører
const B = id(12); // byder, overbudt + favorit
const C = id(13); // kun favorit
const D = id(14); // favorit, typen slået helt fra
const E = id(15); // favorit, kun mail til
const F = id(16); // favorit, slettet konto
const G = id(17); // favorit, fik den gamle påmindelse

const AUK = id(101); // aktiv, slutter om 58 min.
const ANNULLERET = id(102);
const PAUSET = id(103);
const SKJULT = id(104);
const KUNST = id(105);
const FOR_TIDLIG = id(106); // slutter om 2 timer
const FOR_SENT = id(107); // slutter om 5 min.

const STUB = `
create role anon; create role authenticated; create role service_role;
create table public.users (id uuid primary key, konto_slettet_kl timestamptz);
create table public.auctions (
  id uuid primary key, bruger_id uuid not null references public.users(id), titel text not null,
  status text not null default 'aktiv', skjult boolean not null default false,
  pauset_kl timestamptz, kunst_kontrol text, slutter_kl timestamptz not null);
create table public.bids (
  id uuid primary key default gen_random_uuid(), auktion_id uuid not null references public.auctions(id),
  bruger_id uuid not null references public.users(id), "beløb" numeric(12,2) not null,
  oprettet timestamptz not null default now());
create table public.favorites (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id),
  auction_id uuid not null references public.auctions(id), unique (user_id, auction_id));
create table public.notifikation_indstillinger (
  bruger_id uuid not null, type text not null, klokke boolean not null default true,
  mail boolean not null default true, push boolean not null default true, primary key (bruger_id, type));
create table public.notifikation_afsendelser (noegle text primary key, bruger_id uuid, type text not null);
`;

const DATA = `
insert into public.users (id, konto_slettet_kl) values
  ('${SAELGER}', null), ('${A}', null), ('${B}', null), ('${C}', null), ('${D}', null),
  ('${E}', null), ('${F}', now()), ('${G}', null);
insert into public.auctions (id, bruger_id, titel, status, skjult, pauset_kl, kunst_kontrol, slutter_kl) values
  ('${AUK}', '${SAELGER}', 'Cykel', 'aktiv', false, null, null, now() + interval '58 minutes'),
  ('${ANNULLERET}', '${SAELGER}', 'Annulleret', 'annulleret', false, null, null, now() + interval '58 minutes'),
  ('${PAUSET}', '${SAELGER}', 'Pauset', 'aktiv', true, now(), null, now() + interval '58 minutes'),
  ('${SKJULT}', '${SAELGER}', 'Skjult', 'aktiv', true, null, null, now() + interval '58 minutes'),
  ('${KUNST}', '${SAELGER}', 'Kunst', 'aktiv', false, null, 'afventer', now() + interval '58 minutes'),
  ('${FOR_TIDLIG}', '${SAELGER}', 'Tidlig', 'aktiv', false, null, null, now() + interval '2 hours'),
  ('${FOR_SENT}', '${SAELGER}', 'Sen', 'aktiv', false, null, null, now() + interval '5 minutes');
-- B bød først 100, A bød 200 (fører). Samme beløb senere tæller ikke.
insert into public.bids (auktion_id, bruger_id, "beløb", oprettet) values
  ('${AUK}', '${B}', 100, now() - interval '3 hours'),
  ('${AUK}', '${A}', 200, now() - interval '2 hours'),
  ('${AUK}', '${B}', 200, now() - interval '1 hour');
insert into public.favorites (user_id, auction_id) values
  ('${B}', '${AUK}'), ('${C}', '${AUK}'), ('${D}', '${AUK}'), ('${E}', '${AUK}'),
  ('${F}', '${AUK}'), ('${G}', '${AUK}'), ('${SAELGER}', '${AUK}');
insert into public.notifikation_indstillinger (bruger_id, type, klokke, mail, push) values
  ('${D}', 'fulgt_slutter_snart', false, false, false),
  ('${E}', 'fulgt_slutter_snart', false, true, false),
  ('${C}', 'overbudt', false, false, false);
insert into public.notifikation_afsendelser (noegle, bruger_id, type) values
  ('slutter:${AUK}:${G}', '${G}', 'fulgt_slutter_snart');
-- Alle de andre auktioner har både bud og favorit fra C.
insert into public.favorites (user_id, auction_id)
  select '${C}', a.id from public.auctions a where a.id <> '${AUK}';
insert into public.bids (auktion_id, bruger_id, "beløb")
  select a.id, '${A}', 50 from public.auctions a where a.id <> '${AUK}';
`;

type Raekke = {
  auktion_id: string;
  bruger_id: string;
  titel: string;
  budt: boolean;
  foerer: boolean;
  klokke: boolean;
  mail: boolean;
  push: boolean;
};

let db: PGlite;
let foerste: Raekke[];

async function claim(): Promise<Raekke[]> {
  const r = await db.query<Raekke>(`select * from public.paamindelser_foer_slut_claim(2000)`);
  return r.rows;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  await db.exec(DATA);
  foerste = await claim();
});

describe("påmindelse før slut: filtrering", () => {
  it("kun den aktive auktion i vinduet", () => {
    expect(new Set(foerste.map((r) => r.auktion_id))).toEqual(new Set([AUK]));
  });

  it("modtagerne: A, B, C og E - ikke sælgeren, D (slået fra), F (slettet) eller G (gammel nøgle)", () => {
    expect(foerste.map((r) => r.bruger_id).sort()).toEqual([A, B, C, E].sort());
  });

  it("fører / fører ikke / kun favorit", () => {
    const pr = new Map(foerste.map((r) => [r.bruger_id, r]));
    expect(pr.get(A)).toMatchObject({ budt: true, foerer: true });
    // B har både bud og favorit: én række, budt, fører ikke (samme beløb senere).
    expect(pr.get(B)).toMatchObject({ budt: true, foerer: false });
    expect(pr.get(C)).toMatchObject({ budt: false, foerer: false, titel: "Cykel" });
  });

  it("kanalvalget følger med (standard alt til, E kun mail)", () => {
    const pr = new Map(foerste.map((r) => [r.bruger_id, r]));
    expect(pr.get(C)).toMatchObject({ klokke: true, mail: true, push: true });
    expect(pr.get(E)).toMatchObject({ klokke: false, mail: true, push: false });
  });
});

describe("påmindelse før slut: idempotens", () => {
  it("anden kørsel claimer intet", async () => {
    expect(await claim()).toEqual([]);
  });

  it("forlængelse ved sene bud giver ikke en ny", async () => {
    await db.exec(`update public.auctions set slutter_kl = slutter_kl + interval '2 minutes' where id = '${AUK}'`);
    await db.exec(`insert into public.bids (auktion_id, bruger_id, "beløb") values ('${AUK}', '${B}', 300)`);
    expect(await claim()).toEqual([]);
  });

  it("en ny favorit i vinduet får sin egen (én gang)", async () => {
    await db.exec(`update public.notifikation_indstillinger set klokke = true where bruger_id = '${D}'`);
    const r = await claim();
    expect(r.map((x) => x.bruger_id)).toEqual([D]);
    expect(await claim()).toEqual([]);
  });

  it("idempotens-tabellen har én række pr. (auktion, bruger)", async () => {
    const r = await db.query<{ n: number; d: number }>(
      `select count(*)::int n, count(distinct (auktion_id, bruger_id))::int d from public.auktion_paamindelser`,
    );
    expect(r.rows[0].n).toBe(5);
    expect(r.rows[0].d).toBe(5);
  });
});

describe("påmindelse før slut: adgang", () => {
  it("kun service_role kan kalde funktionen og læse tabellen", async () => {
    const r = await db.query<{ rolle: string; fn: boolean; tabel: boolean }>(`
      select rolle,
             has_function_privilege(rolle, 'public.paamindelser_foer_slut_claim(integer)', 'execute') fn,
             has_table_privilege(rolle, 'public.auktion_paamindelser', 'select') tabel
        from unnest(array['anon', 'authenticated', 'service_role']) rolle`);
    const pr = new Map(r.rows.map((x) => [x.rolle, x]));
    expect(pr.get("anon")).toMatchObject({ fn: false, tabel: false });
    expect(pr.get("authenticated")).toMatchObject({ fn: false, tabel: false });
    expect(pr.get("service_role")).toMatchObject({ fn: true, tabel: true });
  });
});
