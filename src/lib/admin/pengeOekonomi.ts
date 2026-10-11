import "server-only";

// Økonomioverblikket i Admin -> Penge (sikkerhedsnet B) - KUN chef.
//
// Hvad er sælgernes (på deres Stripe Connect-konti, ikke udbetalt), hvad er
// BidHamrs (platformens saldo hos Stripe = gebyrer), hvad skylder BidHamr
// købere (refusioner i gang), og - KUN hvis chefen har slået den til - hvad er
// reserve. Månedens gebyrer, refusioner, indsigelser og fragt (indtægt minus
// DAO-omkostning), de seneste posteringer, den daglige afstemnings åbne
// afvigelser og månedens CSV til regnskabet.
//
// Intet her flytter penge (BidHamr har ingen wallet). Stripe-kald er kun
// læsning (platformens saldo, cachet 60 s i penge.ts).

import { notFound } from "next/navigation";
import { assertRole } from "@/lib/adminAuth";
import {
  hentStripeBalance,
  kbhDato,
  kbhMidnat,
  type FragtTilskud,
  type PengeTal,
  type Resultat,
  type StripeBalance,
} from "@/lib/admin/penge";

export type Reserveoverblik = {
  konfiguration: {
    reserve_slaaet_til: boolean;
    reserve_procent: number;
    reserve_periode_dage: number;
    reserve_minimum_oere: number;
    forventet_tab_oere: number;
    aendret_kl: string;
  };
  saelgere: { oere: number; antal_handler: number; konti: number };
  paa_vej_til_bank: { oere: number; antal: number };
  skylder_koebere_oere: number;
  gebyrer_periode_oere: number;
  aabne_indsigelser_oere: number;
  tab_efter_udbetaling: { oere: number; antal: number };
  // null, når reserven er slået fra (den vises så slet ikke).
  reserve: {
    procent_oere: number;
    minimum_oere: number;
    reserve_oere: number;
    brugt_paa_tab_oere: number;
    tilbage_oere: number;
  } | null;
  kan_traekkes_ud_oere: number | null;
  snapshot: {
    kl: string;
    kilde: string;
    livemode: boolean;
    tilgaengelig_oere: number;
    afventer_oere: number;
    saelgere_stripe_oere: number | null;
    saelgerkonti: number | null;
  } | null;
  afstemning: {
    aabne_afvigelser: number;
    seneste_afvigelse_kl: string | null;
    seneste_koersel: {
      startet_kl: string;
      afsluttet_kl: string | null;
      ok: boolean | null;
      ufuldstaendig: boolean;
      antal_afvigelser: number;
      antal_nye: number;
      resultat: Record<string, number> | null;
    } | null;
  };
};

export type Postering = {
  kl: string;
  type: string;
  trade_id: string | null;
  betaling_id: string | null;
  stripe_id: string | null;
  titel: string | null;
  beloeb_oere: number;
  bidhamr_oere: number;
  koebergebyr_oere: number | null;
  saelgergebyr_oere: number | null;
  beskyttelse_oere: number | null;
  fragt_oere: number | null;
  saelger_oere: number | null;
};

export type PengeAfvigelse = {
  id: string;
  type: string;
  stripe_id: string | null;
  betaling_id: string | null;
  stripe_konto: string | null;
  beskrivelse: string;
  beloeb_stripe_oere: number | null;
  beloeb_db_oere: number | null;
  foerst_set_kl: string;
  sidst_set_kl: string;
  antal_set: number;
};

export type Oekonomi = {
  maaned: string; // YYYY-MM
  fra: string;
  til: string;
  balance: Resultat<StripeBalance>;
  reserve: Resultat<Reserveoverblik>;
  tal: Resultat<PengeTal>;
  fragt: Resultat<FragtTilskud>;
  posteringer: Resultat<Postering[]>;
  afvigelser: Resultat<PengeAfvigelse[]>;
};

const MAANED = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MIGRATION = "Kør migrationen 20261019020000_pengeafstemning.sql.";

export function denneMaaned(nu = new Date()): string {
  const d = kbhDato(nu);
  return `${d.aar}-${String(d.maaned).padStart(2, "0")}`;
}

// Måneden som [fra, til) i dansk tid. Ugyldig = denne måned.
export function maanedInterval(v: unknown, nu = new Date()): { maaned: string; fra: Date; til: Date } {
  const m = typeof v === "string" ? MAANED.exec(v) : null;
  const maaned = m ? v as string : denneMaaned(nu);
  const [aar, md] = maaned.split("-").map(Number);
  const fra = kbhMidnat(aar, md, 1);
  const til = md === 12 ? kbhMidnat(aar + 1, 1, 1) : kbhMidnat(aar, md + 1, 1);
  return { maaned, fra, til };
}

export function forrigeMaaned(maaned: string): string {
  const [aar, md] = maaned.split("-").map(Number);
  return md === 1 ? `${aar - 1}-12` : `${aar}-${String(md - 1).padStart(2, "0")}`;
}

export function naesteMaaned(maaned: string): string {
  const [aar, md] = maaned.split("-").map(Number);
  return md === 12 ? `${aar + 1}-01` : `${aar}-${String(md + 1).padStart(2, "0")}`;
}

function dbFejl(tekst: string, err: { code?: string; message: string }): { ok: false; fejl: string } {
  console.error(tekst, err.message);
  const mangler = ["PGRST202", "PGRST205", "42883", "42P01"].includes(err.code ?? "");
  return { ok: false, fejl: mangler ? `${tekst} ${MIGRATION}` : tekst };
}

export async function hentOekonomi(maanedRaa: unknown): Promise<Oekonomi> {
  let admin: Awaited<ReturnType<typeof assertRole>>["admin"];
  let chefId: string;
  try {
    ({ admin, userId: chefId } = await assertRole("chef"));
  } catch {
    notFound();
  }
  const { maaned, fra, til } = maanedInterval(maanedRaa);
  const balance = await hentStripeBalance();
  const tilg = balance.ok ? balance.data.tilgaengelig : null;

  // Platformens saldo gemmes (højst hvert 10. minut fra admin), så databasen
  // altid kan vise den seneste kendte saldo. Fejl her vælter ikke siden.
  if (balance.ok) {
    const { error } = await admin.rpc("penge_saldo_snapshot_gem", {
      p_kilde: "admin",
      p_livemode: !balance.data.testmiljoe,
      p_tilgaengelig: balance.data.tilgaengelig,
      p_afventer: balance.data.afventer,
      p_saelgere: null,
      p_konti: null,
    });
    if (error) console.error("penge_saldo_snapshot_gem:", error.message);
  }

  const [r, t, f, p, a] = await Promise.all([
    admin.rpc("admin_penge_reserve", { p_chef: chefId, p_tilgaengelig_oere: tilg }),
    admin.rpc("admin_penge_tal", { p_fra: fra.toISOString(), p_til: til.toISOString() }),
    admin.rpc("admin_fragt_tilskud", { p_fra: fra.toISOString(), p_til: til.toISOString() }),
    admin.rpc("admin_penge_posteringer", { p_chef: chefId, p_fra: null, p_til: null, p_graense: 25 }),
    admin
      .from("penge_afstemning_afvigelser")
      .select("id, type, stripe_id, betaling_id, stripe_konto, beskrivelse, beloeb_stripe_oere, beloeb_db_oere, foerst_set_kl, sidst_set_kl, antal_set")
      .is("loest_kl", null)
      .order("sidst_set_kl", { ascending: false })
      .limit(50),
  ]);

  return {
    maaned,
    fra: fra.toISOString(),
    til: til.toISOString(),
    balance,
    reserve: r.error ? dbFejl("Overblikket kunne ikke hentes fra databasen.", r.error) : { ok: true, data: r.data as Reserveoverblik },
    tal: t.error ? dbFejl("Månedens tal kunne ikke hentes.", t.error) : { ok: true, data: t.data as PengeTal },
    fragt: f.error ? dbFejl("Fragten kunne ikke hentes.", f.error) : { ok: true, data: f.data as FragtTilskud },
    posteringer: p.error
      ? dbFejl("Posteringerne kunne ikke hentes.", p.error)
      : { ok: true, data: (p.data ?? []) as Postering[] },
    afvigelser: a.error
      ? dbFejl("Afstemningens afvigelser kunne ikke hentes.", a.error)
      : { ok: true, data: (a.data ?? []) as PengeAfvigelse[] },
  };
}

// ------------------------------------------------------------- CSV

export const POSTERING_NAVN: Record<string, string> = {
  betaling: "Betaling fra køber",
  gebyr_refusion: "Gebyr refunderet",
  tilbagefoersel: "Hentet tilbage fra sælger (refusion)",
  refusion: "Refunderet til køber",
  indsigelse: "Indsigelse åbnet",
  indsigelse_tilbagefoersel: "Hentet tilbage fra sælger (indsigelse)",
  indsigelse_tab: "Tab ved indsigelse efter udbetaling",
  udbetaling: "Udbetalt til sælgers bank",
  udbetaling_fejlet: "Udbetaling fejlet (retur på sælgers konto)",
  afvigelse: "Betaling med forkert beløb",
  afvigelse_refunderet: "Forkert beløb refunderet",
};

// Danske beløb: "1234,50" (ingen tusindtalsseparator - regneark læser dem).
export function csvKr(oere: number | null | undefined): string {
  if (oere === null || oere === undefined) return "";
  const n = Math.round(Number(oere));
  const fortegn = n < 0 ? "-" : "";
  const a = Math.abs(n);
  return `${fortegn}${Math.floor(a / 100)},${String(a % 100).padStart(2, "0")}`;
}

// Tekstfelter: altid i anførselstegn ("" for "). Starter teksten med =, +, -,
// @, tab eller CR, sættes ' foran, så regnearket aldrig læser den som en
// formel. Beløb er tal (fx 1234,50) og står uden anførselstegn - de kan ikke
// indeholde ; , " eller linjeskift.
export function csvTekst(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvTal(v: string): string {
  return /^-?\d+,\d{2}$/.test(v) || v === "" ? v : csvTekst(v);
}

export const CSV_MAKS_RAEKKER = 20_000;

export class ForMangeRaekker extends Error {}

export function pengeCsv(rows: Postering[]): string {
  if (rows.length > CSV_MAKS_RAEKKER) {
    throw new ForMangeRaekker(`Måneden har over ${CSV_MAKS_RAEKKER} posteringer`);
  }
  const hoved = [
    "Dato (dansk tid)",
    "Type",
    "Handel-id",
    "Betaling-id",
    "Stripe-id",
    "Vare",
    "Beløb (kr)",
    "BidHamrs saldo +/- (kr)",
    "Købergebyr (kr)",
    "Sælgergebyr (kr)",
    "BidHamr Beskyttelse (kr)",
    "Fragt (kr)",
    "Sælgers konto +/- (kr)",
  ];
  const tid = (iso: string) =>
    new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Copenhagen" }).replace("T", " ");
  const linjer = [...rows]
    .sort((a, b) => a.kl.localeCompare(b.kl))
    .map((r) =>
      [
        csvTekst(tid(r.kl)),
        csvTekst(POSTERING_NAVN[r.type] ?? r.type),
        csvTekst(r.trade_id ?? ""),
        csvTekst(r.betaling_id ?? ""),
        csvTekst(r.stripe_id ?? ""),
        csvTekst(r.titel ?? ""),
        csvTal(csvKr(r.beloeb_oere)),
        csvTal(csvKr(r.bidhamr_oere)),
        csvTal(csvKr(r.koebergebyr_oere)),
        csvTal(csvKr(r.saelgergebyr_oere)),
        csvTal(csvKr(r.beskyttelse_oere)),
        csvTal(csvKr(r.fragt_oere)),
        csvTal(csvKr(r.saelger_oere)),
      ].join(";"),
    );
  // BOM, så Excel læser æ, ø og å rigtigt (ingen "sep="-linje - den får
  // Excel til at ignorere BOM'en). Dansk Excel bruger semikolon som standard.
  return "\uFEFF" + [hoved.map(csvTekst).join(";"), ...linjer].join("\r\n") + "\r\n";
}
