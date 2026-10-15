// Migrationen 20261023010000_kunst_forbudt.sql i PGlite (Postgres i processen -
// ingen database, intet netværk). De funktioner og policyer, migrationen
// ændrer, oprettes først med deres hidtidige definition fra de ældre
// migrationer (md5 skal være prods), resten stubbes. Migrationen køres TO
// gange, og der tjekkes:
// - public.kunst_tekst_tjek giver præcis det samme som tjekKunstTekst (TS)
// - markering, kontrol ('afventer') og automatisk anmeldelse
// - en auktion, der afventer, er skjult for andre (RLS) og kan ikke bydes på
// - brugeren kan ikke selv ændre kontrollen; staff kan godkende
// - samme tekst, som staff har afgjort, sendes ikke til tjek igen
// - 'kunst' i regler, kategorier og checks; brugerbetingelser 0.2
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kunstPar, kunstSloerVariant, tjekKunstTekst } from "@/lib/kunstForbud";
import { FORBUDTE_KATEGORIER, normaliserTekst } from "@/lib/forbudteVarer";
import { DSA_REGLER } from "@/lib/dsa/regler";
import { VILKAAR_VERSION } from "@/lib/vilkaar";
import { KUNST_JA, KUNST_NEJ } from "../enhed/kunstEksempler";

const mig = (navn: string) =>
  readFileSync(path.resolve(import.meta.dirname, "../../supabase/migrations", navn), "utf8").replace(/\r/g, "");

const MIGRATION = mig("20261023010000_kunst_forbudt.sql");

// Henter "create or replace function public.<navn>(" ... "$fn$;" fra en ældre migration.
function funktion(fil: string, navn: string): string {
  const tekst = mig(fil);
  const start = tekst.indexOf(`create or replace function public.${navn}(`);
  if (start < 0) throw new Error(`${navn} findes ikke i ${fil}`);
  const slut = tekst.indexOf("\n$fn$;", start);
  return tekst.slice(start, slut + "\n$fn$;".length);
}

const SYSTEM = "00000000-0000-0000-0000-000000000001";
const SAELGER = "00000000-0000-0000-0000-0000000000aa";
const ANDEN = "00000000-0000-0000-0000-0000000000bb";

const STUB = `
create role anon; create role authenticated; create role service_role;
create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create function auth.role() returns text language sql stable
  as $$ select nullif(current_setting('test.rolle', true), '') $$;
create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function public.er_staff() returns boolean language sql stable
  as $$ select coalesce(current_setting('test.staff', true), '') = '1' $$;
create function public.auktion_arkiv_adgang(p_auktion uuid) returns boolean language sql stable
  as $$ select false $$;
create function public.bidhamr_system_id() returns uuid language sql immutable
  as $$ select '${SYSTEM}'::uuid $$;
create function public.auktion_kategorier() returns text[] language sql immutable
  as $$ select array['Elektronik', 'Møbler', 'Tøj & sko', 'Biler', 'Legetøj', 'Sport', 'Havemøbler', 'Andet'] $$;
create table public.auctions (
  id uuid primary key default gen_random_uuid(),
  bruger_id uuid not null,
  titel text not null,
  beskrivelse text,
  kategori text,
  skjult boolean not null default false,
  status text not null default 'aktiv',
  oprettet timestamptz not null default now(),
  arkiveret_kl timestamptz);
grant select (id, bruger_id, titel, beskrivelse, kategori, skjult, arkiveret_kl) on public.auctions to anon, authenticated;
grant insert, update on public.auctions to authenticated;
alter table public.auctions enable row level security;
create policy auctions_select_anon on public.auctions for select to anon
  using ((arkiveret_kl IS NULL) AND (NOT COALESCE(skjult, false)));
create policy auctions_select_authenticated on public.auctions for select to authenticated
  using (((arkiveret_kl IS NULL) AND (NOT COALESCE(skjult, false))) OR (bruger_id = ( SELECT auth.uid() AS uid)) OR ( SELECT er_staff() AS er_staff) OR auktion_arkiv_adgang(id));
create table public.bids (
  id uuid primary key default gen_random_uuid(), auktion_id uuid not null, bruger_id uuid not null, beloeb numeric);
create table public.bud_maksimum (
  auktion_id uuid not null, bruger_id uuid not null, maks_beloeb numeric, primary key (auktion_id, bruger_id));
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid, reporter_id uuid, category text, description text,
  created_at timestamptz not null default now(), status text not null default 'pending',
  handled_by uuid, handled_note text, handled_at timestamptz,
  constraint reports_category_check check (category = any ('{andet,forbudt_vare,ulovlig_vare}'::text[])));
create table public.users (id uuid primary key, rolle text);
create table public.dsa_afgoerelser (
  id uuid primary key default gen_random_uuid(), indhold_type text, indhold_id uuid, regel_kode text, handling text);
create table public.dsa_anmeldelser (
  id uuid primary key default gen_random_uuid(), kategori text not null,
  constraint dsa_anmeldelser_kategori_check check (kategori = any (array['forbudt_vare', 'andet'])));
${funktion("20261006042000_forbudte_varer_skaerpet.sql", "forbudt_normaliser")}
${funktion("20261006042000_forbudte_varer_skaerpet.sql", "forbudte_varer")}
${funktion("20261009030000_testrettelser_dsa_sikkerhed.sql", "dsa_regler")}
${funktion("20261009011000_dsa_rettelser.sql", "dsa_anmeldelse_opret")}
${funktion("20261009050000_vilkaar_accept.sql", "vilkaar_aktuel_version")}
${funktion("20261017030000_vilkaar_efternavn_chat.sql", "vilkaar_er_accepteret")}
insert into public.users (id, rolle) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'),
  ('00000000-0000-0000-0000-0000000000a2', 'medarbejder'),
  ('00000000-0000-0000-0000-0000000000a3', 'bruger');
`;

const ADMIN = "00000000-0000-0000-0000-0000000000a1";
const MEDARBEJDER = "00000000-0000-0000-0000-0000000000a2";
const BRUGER = "00000000-0000-0000-0000-0000000000a3";

const MD5 = `select md5(lower(regexp_replace(regexp_replace(replace(p.prosrc, chr(13), ''), '--[^\\n]*', '', 'g'), '\\s', '', 'g'))) as h
  from pg_proc p where p.oid = to_regprocedure($1)`;

let db: PGlite;

async function md5(fn: string): Promise<string> {
  const r = await db.query<{ h: string }>(MD5, [fn]);
  return r.rows[0]?.h ?? "";
}

async function som(rolle: string | null, uid: string | null = SAELGER) {
  await db.query("select set_config('test.rolle', $1, false), set_config('test.uid', $2, false)", [
    rolle ?? "",
    uid ?? "",
  ]);
}

async function opret(titel: string, beskrivelse: string | null = null, bekraeftet?: boolean): Promise<string> {
  const r = await db.query<{ id: string }>(
    bekraeftet === undefined
      ? "insert into public.auctions (bruger_id, titel, beskrivelse) values ($1, $2, $3) returning id"
      : "insert into public.auctions (bruger_id, titel, beskrivelse, kunst_bekraeftet) values ($1, $2, $3, $4) returning id",
    bekraeftet === undefined ? [SAELGER, titel, beskrivelse] : [SAELGER, titel, beskrivelse, bekraeftet],
  );
  return r.rows[0].id;
}

async function auktion(id: string) {
  const r = await db.query<{ kunst_markeret_kl: string | null; kunst_bekraeftet: boolean; kunst_kontrol: string | null }>(
    "select kunst_markeret_kl, kunst_bekraeftet, kunst_kontrol from public.auctions where id = $1",
    [id],
  );
  return r.rows[0];
}

async function rapporter(id: string) {
  const r = await db.query<{ id: string; category: string; description: string; reporter_id: string; status: string }>(
    "select id, category, description, reporter_id, status from public.reports where auction_id = $1 order by created_at",
    [id],
  );
  return r.rows;
}

// Kan rollen se auktionen (RLS)? Kører som rollen og sætter rollen tilbage.
async function kanSe(rolle: "anon" | "authenticated", uid: string | null, id: string, staff = false): Promise<boolean> {
  await db.query("select set_config('test.uid', $1, false), set_config('test.staff', $2, false)", [
    uid ?? "",
    staff ? "1" : "",
  ]);
  await db.exec(`set role ${rolle}`);
  try {
    const r = await db.query<{ id: string }>("select id from public.auctions where id = $1", [id]);
    return r.rows.length === 1;
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('test.staff', '', false)");
  }
}

async function fejlkode(sql: string, params: unknown[]): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "ukendt";
  }
}

const GAMLE_MD5: Record<string, string> = {
  "public.forbudte_varer()": "26f66c209eafd8851d51bc524a5771bc",
  "public.dsa_regler()": "3c089e00118b314b50a3b2fcdc988c8d",
  "public.dsa_anmeldelse_opret(uuid,text,uuid,text,text,text,text,text,boolean)": "10671a6ecac0d9faaae0518587047ff9",
  "public.vilkaar_aktuel_version()": "f87f0070b496a88af134964e29b310ce",
  "public.vilkaar_er_accepteret(text)": "2985fecec0ac4740a4d17ebc244b8020",
};
const GAMLE_POLICY_MD5: Record<string, string> = {
  auctions_select_anon: "e8ff1c7e4468e4aa59f122841dc1a3fc",
  auctions_select_authenticated: "15a38a05e63952aaf613e3cea3111374",
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  // Stubbene skal være prods funktioner og policyer - ellers tester
  // drift-tjekket ingenting.
  for (const [fn, h] of Object.entries(GAMLE_MD5)) {
    expect(await md5(fn), fn).toBe(h);
  }
  const pol = await db.query<{ polname: string; h: string }>(
    "select polname, md5(pg_get_expr(polqual, polrelid)) as h from pg_policy where polrelid = 'public.auctions'::regclass",
  );
  for (const p of pol.rows) expect(p.h, p.polname).toBe(GAMLE_POLICY_MD5[p.polname]);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("migrationen", () => {
  it("de ændrede funktioner har den md5, migrationen forventer", async () => {
    for (const fn of Object.keys(GAMLE_MD5)) {
      const h = await md5(fn);
      expect(MIGRATION, `${fn} har nu md5 ${h}`).toContain(`'${h}'`);
    }
  });

  it("'kunst' er tilføjet regler, kategorier og checks", async () => {
    const regel = await db.query<{ kode: string; navn: string; grundlag: string; henvisning: string }>(
      "select kode, navn, grundlag, henvisning from public.dsa_regler() where kode = 'kunst'",
    );
    expect(regel.rows[0]).toEqual(DSA_REGLER.find((r) => r.kode === "kunst"));
    const kat = await db.query<{ kode: string; navn: string; beskrivelse: string }>(
      "select kode, navn, beskrivelse from public.forbudte_varer() where kode = 'kunst'",
    );
    expect(kat.rows[0]).toEqual(FORBUDTE_KATEGORIER.find((k) => k.kode === "kunst"));
    const alle = await db.query<{ kode: string }>("select kode from public.dsa_regler()");
    expect(alle.rows.map((r) => r.kode)).toEqual(DSA_REGLER.map((r) => r.kode));
    const checks = await db.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname in ('reports_category_check', 'dsa_anmeldelser_kategori_check')",
    );
    expect(checks.rows).toHaveLength(2);
    for (const c of checks.rows) expect(c.def).toContain("kunst");
    const src = await db.query<{ prosrc: string }>("select prosrc from pg_proc where proname = 'dsa_anmeldelse_opret'");
    expect(src.rows[0].prosrc).toContain("'vilkaar', 'kunst', 'andet'");
  });

  it("brugerbetingelserne er version 0.2 - samme som hjemmesiden - og stable", async () => {
    const r = await db.query<{ v: string; a: boolean; b: boolean }>(
      "select public.vilkaar_aktuel_version() as v, public.vilkaar_er_accepteret('0.1') as a, public.vilkaar_er_accepteret('0.2') as b",
    );
    expect(r.rows[0]).toEqual({ v: "0.2", a: false, b: true });
    expect(VILKAAR_VERSION).toBe("0.2");
    const vol = await db.query<{ proname: string; provolatile: string }>(
      "select proname, provolatile from pg_proc where proname in ('vilkaar_aktuel_version', 'vilkaar_er_accepteret')",
    );
    for (const f of vol.rows) expect(f.provolatile, f.proname).toBe("s");
  });

  it("nye kolonner kan ikke læses af brugere", async () => {
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.column_privileges
        where table_name = 'auctions' and column_name like 'kunst%'
          and privilege_type = 'SELECT' and grantee in ('anon', 'authenticated')`,
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("policyerne skjuler 'afventer'", async () => {
    const pol = await db.query<{ q: string }>(
      "select pg_get_expr(polqual, polrelid) as q from pg_policy where polrelid = 'public.auctions'::regclass",
    );
    for (const p of pol.rows) expect(p.q).toContain("kunst_kontrol");
  });
});

describe("kunst_tekst_tjek = tjekKunstTekst", () => {
  const ekstra = [
    "Maleri af Kirkeby, olie på lærred, signeret",
    "kunst læder kunst",
    "Grafik, signeret og nummereret 12/50",
    "Buste i bronze",
    "AKVAREL",
    "m.a.l.e.r.i, m a l e r i og ma-leri",
    "x".repeat(6000) + " maleri",
    "maleri " + "x".repeat(6000),
    "A3 3d 1a b0rd",
    "😀".repeat(10) + " Ma-leri",
  ];
  it.each([...KUNST_JA, ...KUNST_NEJ, ...ekstra])("%s", async (t) => {
    const r = await db.query<{ v: unknown; s: string; l: string; p: string }>(
      `select public.kunst_tekst_tjek($1) as v, public.kunst_sloer_variant($1) as s,
              public.kunst_sloer_variant($1, 'l') as l, public.kunst_par(public.forbudt_normaliser($1)) as p`,
      [t],
    );
    expect(r.rows[0].v).toEqual(tjekKunstTekst(t));
    expect(r.rows[0].s).toBe(kunstSloerVariant(t));
    expect(r.rows[0].l).toBe(kunstSloerVariant(t, "l"));
    expect(r.rows[0].p).toBe(kunstPar(normaliserTekst(t)));
  });
});

describe("kontrol, synlighed og anmeldelse", () => {
  it("kunst ved oprettelse: afventer, skjult for andre, én anmeldelse", async () => {
    await som("authenticated");
    const id = await opret("Oliemaleri af skib", "60x80", true);
    const a = await auktion(id);
    expect(a.kunst_markeret_kl).not.toBeNull();
    expect(a.kunst_kontrol).toBe("afventer");
    expect(a.kunst_bekraeftet).toBe(true);
    const r = await rapporter(id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ category: "kunst", reporter_id: SYSTEM, status: "pending" });
    expect(r[0].description).toContain('"oliemaleri"');
    expect(r[0].description).toContain('bekræftet "Det er ikke kunst"');

    expect(await kanSe("anon", null, id)).toBe(false);
    expect(await kanSe("authenticated", ANDEN, id)).toBe(false);
    expect(await kanSe("authenticated", SAELGER, id)).toBe(true);
    expect(await kanSe("authenticated", ANDEN, id, true)).toBe(true);

    // Sælgeren kan læse sin egen status - andre får null.
    await som("authenticated", SAELGER);
    const mig = await db.query<{ k: string | null }>("select public.min_kunst_kontrol($1) as k", [id]);
    expect(mig.rows[0].k).toBe("afventer");
    await som("authenticated", ANDEN);
    const anden = await db.query<{ k: string | null }>("select public.min_kunst_kontrol($1) as k", [id]);
    expect(anden.rows[0].k).toBeNull();
  });

  it("der kan ikke bydes, før staff har godkendt - derefter kan der", async () => {
    await som("authenticated", ANDEN);
    const id = await opret("Akvarel af fyrtårn");
    expect(
      await fejlkode("insert into public.bids (auktion_id, bruger_id, beloeb) values ($1, $2, 100)", [id, ANDEN]),
    ).toBe("BHK01");
    expect(
      await fejlkode("insert into public.bud_maksimum (auktion_id, bruger_id, maks_beloeb) values ($1, $2, 500)", [id, ANDEN]),
    ).toBe("BHK01");

    // Brugeren kan ikke selv godkende.
    await db.query("update public.auctions set kunst_kontrol = 'godkendt' where id = $1", [id]);
    expect((await auktion(id)).kunst_kontrol).toBe("afventer");

    // Staff godkender ("Ikke kunst").
    await som("service_role", null);
    await db.query("update public.auctions set kunst_kontrol = 'godkendt' where id = $1 and kunst_kontrol = 'afventer'", [id]);
    expect((await auktion(id)).kunst_kontrol).toBe("godkendt");
    expect(await kanSe("anon", null, id)).toBe(true);
    expect(
      await fejlkode("insert into public.bids (auktion_id, bruger_id, beloeb) values ($1, $2, 100)", [id, ANDEN]),
    ).toBeNull();
  });

  it("appens insert uden kunst_bekraeftet virker og afventer", async () => {
    await som("authenticated");
    const id = await opret("Litografi signeret");
    const a = await auktion(id);
    expect(a.kunst_bekraeftet).toBe(false);
    expect(a.kunst_kontrol).toBe("afventer");
    const r = await rapporter(id);
    expect(r).toHaveLength(1);
    expect(r[0].description).toContain("ikke bekræftet");
    expect(r[0].description).toMatch(/\d+ andre auktioner/);
  });

  it("almindelig vare: ingen markering og ingen anmeldelse", async () => {
    await som("authenticated");
    const id = await opret("Maleritape og malerpensel");
    const a = await auktion(id);
    expect(a.kunst_markeret_kl).toBeNull();
    expect(a.kunst_kontrol).toBeNull();
    expect(await rapporter(id)).toHaveLength(0);
    expect(await kanSe("anon", null, id)).toBe(true);
  });

  it("brugeren kan ikke selv sætte kontrol eller markering ved oprettelse", async () => {
    await som("authenticated");
    const r = await db.query<{ id: string }>(
      "insert into public.auctions (bruger_id, titel, kunst_markeret_kl, kunst_kontrol) values ($1, 'Sofa', now(), 'godkendt') returning id",
      [SAELGER],
    );
    const a = await auktion(r.rows[0].id);
    expect(a.kunst_markeret_kl).toBeNull();
    expect(a.kunst_kontrol).toBeNull();
    const k = await db.query<{ id: string }>(
      "insert into public.auctions (bruger_id, titel, kunst_kontrol) values ($1, 'Oliemaleri', 'godkendt') returning id",
      [SAELGER],
    );
    expect((await auktion(k.rows[0].id)).kunst_kontrol).toBe("afventer");
  });

  it("rettelse til kunst: afventer og anmeldes - kun én åben anmeldelse", async () => {
    await som("authenticated");
    const id = await opret("Billede");
    await db.query("update public.auctions set titel = 'Akvarel af fyrtårn' where id = $1", [id]);
    expect((await auktion(id)).kunst_kontrol).toBe("afventer");
    await db.query("update public.auctions set beskrivelse = 'Akvarel, indrammet' where id = $1", [id]);
    const r = await rapporter(id);
    expect(r).toHaveLength(1);
    expect(r[0].description).toContain("den rettede titel eller beskrivelse");
  });

  it("samme tekst, som staff har godkendt, sendes ikke til tjek igen - ny kunst-tekst gør", async () => {
    await som("authenticated");
    const id = await opret("Oliemaleri af skib");
    const [rapport] = await rapporter(id);
    await som("service_role", null);
    await db.query("update public.reports set status = 'behandlet' where id = $1", [rapport.id]);
    await db.query("update public.auctions set kunst_kontrol = 'godkendt' where id = $1", [id]);

    await som("authenticated");
    await db.query("update public.auctions set titel = 'Sofa' where id = $1", [id]);
    await db.query("update public.auctions set titel = 'Oliemaleri af skib' where id = $1", [id]);
    expect((await auktion(id)).kunst_kontrol).toBe("godkendt");
    expect(await rapporter(id)).toHaveLength(1);

    await db.query("update public.auctions set titel = 'Akvarel af skib' where id = $1", [id]);
    expect((await auktion(id)).kunst_kontrol).toBe("afventer");
    expect(await rapporter(id)).toHaveLength(2);
  });

  it("afvist og skjult forbliver afvist ved rettelser - synlig igen (medhold) går til tjek", async () => {
    await som("authenticated");
    const id = await opret("Skulptur");
    await som("service_role", null);
    await db.query("update public.auctions set kunst_kontrol = 'afvist', skjult = true where id = $1", [id]);
    await som("authenticated");
    await db.query("update public.auctions set titel = 'Bronzeskulptur' where id = $1", [id]);
    expect((await auktion(id)).kunst_kontrol).toBe("afvist");

    await som("service_role", null);
    await db.query("update public.auctions set skjult = false where id = $1", [id]);
    await som("authenticated");
    await db.query("update public.auctions set titel = 'Marmorskulptur' where id = $1", [id]);
    expect((await auktion(id)).kunst_kontrol).toBe("afventer");
  });

  it("DSA-afgørelse med reglen 'kunst' sætter afvist - også en godkendt", async () => {
    await som("service_role", null);
    const id = await opret("Sofa");
    await db.query("update public.auctions set kunst_kontrol = 'godkendt' where id = $1", [id]);
    await db.query(
      "insert into public.dsa_afgoerelser (indhold_type, indhold_id, regel_kode, handling) values ('auktion', $1, 'kunst', 'auktion_skjult')",
      [id],
    );
    expect((await auktion(id)).kunst_kontrol).toBe("afvist");
    const id2 = await opret("Sofa 2");
    await db.query(
      "insert into public.dsa_afgoerelser (indhold_type, indhold_id, regel_kode, handling) values ('auktion', $1, 'svindel', 'auktion_skjult')",
      [id2],
    );
    expect((await auktion(id2)).kunst_kontrol).toBeNull();
  });

  it("'Ikke kunst' lukker anmeldelsen og godkender i én transaktion - kun staff, kun én gang", async () => {
    await som("authenticated");
    const id = await opret("Oliemaleri af fyr");
    const [rapport] = await rapporter(id);
    await som("service_role", null);
    const nej = await db.query<{ r: { kode: string } }>("select public.kunst_ikke_kunst($1, $2, 'tjekket') as r", [
      BRUGER,
      rapport.id,
    ]);
    expect(nej.rows[0].r.kode).toBe("ingen_adgang");
    expect((await auktion(id)).kunst_kontrol).toBe("afventer");
    const ja = await db.query<{ r: { kode: string } }>("select public.kunst_ikke_kunst($1, $2, 'Plakat') as r", [
      MEDARBEJDER,
      rapport.id,
    ]);
    expect(ja.rows[0].r.kode).toBe("ok");
    expect((await auktion(id)).kunst_kontrol).toBe("godkendt");
    expect((await rapporter(id))[0].status).toBe("behandlet");
    const igen = await db.query<{ r: { kode: string } }>("select public.kunst_ikke_kunst($1, $2, 'Plakat') as r", [
      MEDARBEJDER,
      rapport.id,
    ]);
    expect(igen.rows[0].r.kode).toBe("allerede");
  });

  it("'Tjek aktive auktioner for kunst' sætter fundne til tjek med anmeldelse (kun admin/chef)", async () => {
    // En gammel auktion fra før kontrollen: ingen markering.
    await som("service_role", null);
    const id = await opret("Litografi af Jorn");
    await db.query("update public.auctions set kunst_kontrol = null, kunst_markeret_kl = null where id = $1", [id]);
    await db.query("delete from public.reports where auction_id = $1", [id]);

    const nej = await db.query<{ r: { kode: string } }>("select public.kunst_tjek_aktive($1) as r", [MEDARBEJDER]);
    expect(nej.rows[0].r.kode).toBe("ingen_adgang");
    const ja = await db.query<{ r: { kode: string; fundet: number } }>("select public.kunst_tjek_aktive($1) as r", [ADMIN]);
    expect(ja.rows[0].r.kode).toBe("ok");
    expect(ja.rows[0].r.fundet).toBeGreaterThanOrEqual(1);
    const a = await auktion(id);
    expect(a.kunst_kontrol).toBe("afventer");
    expect(a.kunst_markeret_kl).not.toBeNull();
    expect(await rapporter(id)).toHaveLength(1);
  });

  it("ugyldig kontrol-værdi afvises", async () => {
    await som("service_role", null);
    const id = await opret("Sofa");
    expect(await fejlkode("update public.auctions set kunst_kontrol = 'noget' where id = $1", [id])).toBe("23514");
  });

  it("oprettelse via service_role (fx 'sæt varen op igen') afventer og anmeldes", async () => {
    await som("service_role", null);
    const id = await opret("Bronzefigur");
    expect((await auktion(id)).kunst_kontrol).toBe("afventer");
    expect(await rapporter(id)).toHaveLength(1);
  });
});
