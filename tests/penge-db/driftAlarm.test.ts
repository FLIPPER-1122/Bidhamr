// Migrationen 20261021030000_drift_alarm_blokke.sql i PGlite (Postgres i
// processen - ingen database, intet netværk). Stubber de tabeller, den bygger
// på, kører den TO gange og tjekker:
// - drift_alarm_kode() giver det samme som alarmKode() (src/lib/driftAlarmTyper.ts)
// - drift_alarm_er_roed() giver samme alvor som alarmType()
// - spam-værnet: røde og nye fejl sendes med det samme, gule venter en time
// - en fejlet mail lægges tilbage og gendanner "sidst sendt"
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALARM_TYPER, alarmKode, alarmType } from "@/lib/driftAlarmTyper";

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/migrations/20261021030000_drift_alarm_blokke.sql"),
  "utf8",
);

const STUB = `
create role anon; create role authenticated; create role service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table public.drift_fejl (
  id bigserial primary key, kilde text not null, sti text, besked text not null, digest text,
  bruger_id uuid, antal integer not null default 1,
  oprettet_kl timestamptz not null default now(), senest_kl timestamptz not null default now());
create table public.drift_fejl_minut (minut timestamptz primary key, antal integer not null default 0);
create table public.drift_alarmer (
  slags text primary key, daekket_til timestamptz not null default now(), sidst_sendt_kl timestamptz,
  antal_sendt integer not null default 0, sidst_udloest_kl timestamptz, sidste_resultat text);
insert into public.drift_alarmer (slags) values ('ny_fejl'), ('mange_fejl'), ('cron'), ('webhook');
create table public.drift_alarm_tilstand (
  id boolean primary key default true, sidst_tjekket_kl timestamptz, sidste_resultat text, sidste_fejl text);
insert into public.drift_alarm_tilstand (id) values (true);
create table public.drift_alarm_kald (request_id bigint primary key, oprettet_kl timestamptz not null default now());
create table public.drift_cron_koersler (
  id bigserial primary key, job text not null, ok boolean, fejl text,
  startet_kl timestamptz not null default now(), afsluttet_kl timestamptz);
`;

// Samme eksempler som tests/enhed/driftAlarm.test.ts.
const KODE_EKSEMPLER: [string, string | null][] = [
  ["webhook", "betaling/ukendt-betaling: Charge ch_3UQ4Ab01XyZq til en sælgerkonto er gennemført hos Stripe"],
  ["webhook", "betaling/ukendt-betaling: Charge ch_3UQ4Ab02XyZq til en sælgerkonto er gennemført hos Stripe"],
  ["server", "Fragt: priser: fejl 500"],
  ["cron", "DAC7-cron: noget gik galt"],
  ["server", "Charge ch_3UQ4AbCdEf12 til en sælgerkonto er gennemført"],
  ["server", "Charge ch_9ZZZzzzzzz99 til en sælgerkonto er gennemført"],
  ["server", "Udbetaling 123e4567-e89b-12d3-a456-426614174000: x"],
  ["klient", "TypeError: <script>"],
  ["server", ""],
  ["server", null],
  ["server", "https://x.dk: noget"],
  ["cron", "Udbetaling til sælger: timeout fra Stripe"],
  ["webhook", "payment_intent.succeeded: relation \"x\" does not exist"],
  ["server", "Pengeafstemning: payouts (Stripe-tilstand): fejl"],
  ["server", "Tilbageførsel ved tabt indsigelse: Error: x"],
  ["server", "Helt ny fejl uden hvor 123e4567-e89b-12d3-a456-426614174000 og mere tekst, der er længere end tres tegn"],
];

let db: PGlite;

async function en<T = Record<string, unknown>>(sql: string, p: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, p);
  return r.rows[0];
}

type Svar = {
  blokke: { noegle: string; antal: number; gentaget: boolean; forrige_sendt_kl: string | null; forrige_antal: number }[];
  holdt: { slags: string; noegle: string }[];
  tidspunkt: string;
};
const vurder = async (kanSende = true) =>
  (await en<{ r: Svar }>("select public.drift_alarm_vurder_blokke($1) as r", [kanSende])).r;
const noegler = (s: Svar) => s.blokke.map((b) => b.noegle).sort();

async function fejl(kilde: string, besked: string, sti: string | null = null) {
  await db.query(
    `insert into public.drift_fejl (kilde, sti, besked, oprettet_kl, senest_kl)
     values ($1, $2, $3, now() - interval '30 seconds', now() - interval '30 seconds')`,
    [kilde, sti, besked],
  );
}
// Åbn vinduet lige efter de rækker, der allerede er set (højst 1 minut
// tilbage), så de næste rækker, der indsættes, ses - og kun de.
const aabnVindue = () =>
  db.exec(`update public.drift_alarmer set daekket_til = greatest(now() - interval '1 minute',
    coalesce((select max(greatest(f.oprettet_kl, f.senest_kl)) from public.drift_fejl f), '-infinity'))`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION); // skal kunne køres flere gange
});
afterAll(async () => {
  await db.close();
});

describe("drift_alarm_kode = alarmKode", () => {
  it.each(KODE_EKSEMPLER)("%s: %s", async (kilde, besked) => {
    const r = await en<{ k: string }>("select public.drift_alarm_kode($1, $2) as k", [kilde, besked]);
    expect(r.k).toBe(alarmKode(kilde, besked));
  });
});

describe("drift_alarm_er_roed = alarmType().alvor", () => {
  const kilder = ["server", "webhook", "cron", "action", "klient", "*"];
  const koder = [
    ...Object.keys(ALARM_TYPER),
    "betaling/noget-nyt",
    "Pengeafstemning",
    "Fragt",
    "erhverv/noget",
    "connect/noget",
    "Noget helt andet",
    "payment_intent.succeeded",
  ];
  it("alle kendte koder og reserverne", async () => {
    const forskelle: string[] = [];
    for (const kilde of kilder) {
      for (const kode of koder) {
        const r = await en<{ roed: boolean }>("select public.drift_alarm_er_roed($1, $2) as roed", [kilde, kode]);
        if (r.roed !== (alarmType(kilde, kode).alvor === "roed")) forskelle.push(`${kilde}|${kode}`);
      }
    }
    expect(forskelle).toEqual([]);
  });
});

describe("drift_alarm_vurder_blokke", () => {
  beforeEach(async () => {
    await db.exec(`delete from public.drift_fejl; delete from public.drift_alarm_blokke; delete from public.drift_fejl_minut;
      update public.drift_alarmer set daekket_til = now(), sidst_sendt_kl = null;`);
  });

  it("samler samme type i én blok med antal", async () => {
    await aabnVindue();
    for (let i = 1; i <= 12; i++) await fejl("webhook", `betaling/ukendt-betaling: Charge ch_3UQ4Ab${String(i).padStart(2, "0")}XyZq ukendt`);
    await fejl("webhook", "payment_intent.succeeded: boom", "stripe-webhook");
    const s = await vurder();
    expect(noegler(s)).toEqual(["webhook|betaling/ukendt-betaling", "webhook|payment_intent.succeeded"]);
    expect(s.blokke.find((b) => b.noegle === "webhook|betaling/ukendt-betaling")?.antal).toBe(12);
  });

  it("røde blokke sendes med det samme, også inden for timen", async () => {
    await aabnVindue();
    await fejl("webhook", "betaling/ukendt-betaling: Charge ch_3UQ4Ab01XyZq ukendt");
    expect(noegler(await vurder())).toEqual(["webhook|betaling/ukendt-betaling"]);
    await aabnVindue();
    await fejl("webhook", "betaling/ukendt-betaling: Charge ch_3UQ4Ab02XyZq ukendt");
    const s = await vurder();
    expect(noegler(s)).toEqual(["webhook|betaling/ukendt-betaling"]);
    expect(s.blokke[0].antal).toBe(1);
  });

  it("en ny fejltekst sendes med det samme, også inden for timen", async () => {
    await aabnVindue();
    await fejl("server", "Fragt: priser: fejl A");
    expect(noegler(await vurder())).toEqual(["server|Fragt"]);
    await aabnVindue();
    await fejl("server", "Fragt: priser: en helt anden fejl B");
    expect(noegler(await vurder())).toEqual(["server|Fragt"]);
  });

  it("gule cron-blokke og browser-fejl venter en time og kommer så med", async () => {
    await aabnVindue();
    await fejl("cron", "Udbetaling til sælger: timeout", "betalings-cron");
    await fejl("klient", "TypeError: a");
    expect(noegler(await vurder())).toEqual(["cron|Udbetaling til sælger", "klient|klient"]);

    await aabnVindue();
    await fejl("cron", "Udbetaling til sælger: timeout igen", "betalings-cron");
    await fejl("klient", "TypeError: b");
    const s = await vurder();
    expect(s.blokke).toEqual([]);
    expect(s.holdt.map((h) => h.noegle).sort()).toEqual(["cron|Udbetaling til sælger", "klient|klient"]);
    const t = await en<{ r: string }>("select public.drift_alarm_vurder_blokke(true)->>'blokke' as r");
    expect(JSON.parse(t.r)).toEqual([]);
    const tilstand = await en<{ r: string }>("select sidste_resultat as r from public.drift_alarm_tilstand");
    expect(tilstand.r).toBe("ingen");

    await db.exec(`update public.drift_alarm_blokke set sidst_sendt_kl = now() - interval '61 minutes'`);
    const efter = await vurder();
    expect(noegler(efter)).toEqual(["cron|Udbetaling til sælger", "klient|klient"]);
    expect(efter.blokke.every((b) => b.antal === 1)).toBe(true);
  });

  it("markant stigning sendes igen inden for timen", async () => {
    await aabnVindue();
    await fejl("cron", "Udbetaling til sælger: a", "betalings-cron");
    await vurder();
    await aabnVindue();
    for (const x of ["b", "c", "d"]) await fejl("cron", `Udbetaling til sælger: ${x}`, "betalings-cron");
    const s = await vurder();
    expect(s.blokke[0]?.gentaget).toBe(true);
    expect(s.blokke[0]?.antal).toBe(3);
  });

  it("fejlet mail: blokken lægges tilbage, sidst sendt gendannes, og den sendes ved næste kørsel", async () => {
    await aabnVindue();
    await fejl("cron", "Udbetaling til sælger: a", "betalings-cron");
    const foerste = await vurder();
    const foersteKl = (await en<{ k: string }>("select sidst_sendt_kl::text as k from public.drift_alarm_blokke")).k;

    await db.exec(`update public.drift_alarm_blokke set sidst_sendt_kl = now() - interval '61 minutes'`);
    const gammelKl = (await en<{ k: string }>("select sidst_sendt_kl::text as k from public.drift_alarm_blokke")).k;
    await aabnVindue();
    await fejl("cron", "Udbetaling til sælger: b", "betalings-cron");
    const anden = await vurder();
    expect(anden.blokke).toHaveLength(1);
    await db.query("select public.drift_alarm_blokke_fejlet($1, $2::jsonb, 'test')", [
      anden.tidspunkt,
      JSON.stringify(anden.blokke),
    ]);
    const b = await en<{ kl: string; tving: boolean; venter: number }>(
      "select sidst_sendt_kl::text as kl, tving_send as tving, venter_antal::int as venter from public.drift_alarm_blokke",
    );
    expect(b.kl).toBe(gammelKl);
    expect(b.kl).not.toBe(foersteKl);
    expect(b.tving).toBe(true);
    expect(b.venter).toBe(1);
    expect(foerste.blokke).toHaveLength(1);

    const tredje = await vurder();
    expect(noegler(tredje)).toEqual(["cron|Udbetaling til sælger"]);
    const efter = await en<{ tving: boolean }>("select tving_send as tving from public.drift_alarm_blokke");
    expect(efter.tving).toBe(false);
  });

  it("ingen modtager: intet sendes, hændelserne regnes for set", async () => {
    await aabnVindue();
    await fejl("webhook", "betaling/ukendt-betaling: Charge ch_3UQ4Ab01XyZq ukendt");
    const r = await en<{ r: { blokke: unknown[]; ingen_modtager: unknown[] } }>(
      "select public.drift_alarm_vurder_blokke(false) as r",
    );
    expect(r.r.blokke).toEqual([]);
    expect(r.r.ingen_modtager).toHaveLength(1);
  });

  it("service_role kan kun læse tabellen", async () => {
    const r = await en<{ s: boolean; i: boolean; u: boolean; d: boolean }>(`select
      has_table_privilege('service_role', 'public.drift_alarm_blokke', 'select') as s,
      has_table_privilege('service_role', 'public.drift_alarm_blokke', 'insert') as i,
      has_table_privilege('service_role', 'public.drift_alarm_blokke', 'update') as u,
      has_table_privilege('service_role', 'public.drift_alarm_blokke', 'delete') as d`);
    expect(r).toEqual({ s: true, i: false, u: false, d: false });
  });
});
