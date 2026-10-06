import Link from "next/link";
import { kraevSideRolle } from "@/lib/adminAuth";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import CsvKnap from "@/components/admin/CsvKnap";
import { anmeldKategoriNavn, handlingNavn, indholdNavn, regelNavn } from "@/lib/dsa/regler";

// Gennemsigtighedsrapport (DSA art. 15 og 24): tal for en valgt periode.
// Kun admin og chef. Ingen persondata - kun antal (dsa_rapport i databasen).

export const dynamic = "force-dynamic";

type Rapport = {
  fra: string;
  til: string;
  anmeldelser: {
    i_alt: number;
    aabne: number;
    uden_login: number;
    videresendt: number;
    politi_underrettet: number;
    median_timer: number | null;
    pr_kategori: { kategori: string; antal: number; indgreb: number; ingen_overtraedelse: number; ikke_fundet: number; aabne: number }[];
    pr_indhold: { indhold_type: string; antal: number }[];
  };
  indgreb: {
    i_alt: number;
    efter_anmeldelse: number;
    eget_initiativ: number;
    automatisk_opdaget: number;
    manuelt_opdaget: number;
    automatisk_afgjort: number;
    ophaevet: number;
    pr_handling: { handling: string; antal: number }[];
    pr_regel: { regel: string; grundlag: string; antal: number }[];
    pr_grundlag: { lov: number; vilkaar: number };
  };
  suspenderinger: { midlertidige: number; permanente: number; lukkede_konti: number };
  klager: {
    i_alt: number;
    over_indgreb: number;
    fra_anmeldere: number;
    medhold: number;
    fastholdt: number;
    aabne: number;
    median_timer: number | null;
  };
  oevrige_rapporter: {
    auktioner_fra_brugere: number;
    auktioner_automatisk: number;
    brugere_og_bedoemmelser: number;
    spamfilter: number;
  };
};

const DATO = /^\d{4}-\d{2}-\d{2}$/;

function isoDato(d: Date) {
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
}

// Midnat i dansk tid (sommer- og vintertid) for en dato "YYYY-MM-DD".
function kbhMidnat(dato: string): Date {
  const utc = new Date(`${dato}T00:00:00Z`);
  const lokal = new Date(utc.toLocaleString("en-US", { timeZone: "Europe/Copenhagen" }));
  const ren = new Date(utc.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(utc.getTime() - (lokal.getTime() - ren.getTime()));
}

function Tal({ titel, vaerdi, note }: { titel: string; vaerdi: string | number; note?: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{titel}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-neutral-900">{vaerdi}</p>
      {note && <p className="mt-0.5 text-xs text-neutral-500">{note}</p>}
    </div>
  );
}

function Tabel({ titel, kolonner, raekker }: { titel: string; kolonner: string[]; raekker: (string | number)[][] }) {
  return (
    <section className="space-y-2" aria-label={titel}>
      <h2 className="text-sm font-semibold text-neutral-800">{titel}</h2>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
        <table className="w-full min-w-[480px] text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              {kolonner.map((k, i) => (
                <th key={k} className={`px-4 py-2.5 ${i > 0 ? "text-right" : ""}`}>{k}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {raekker.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className={`px-4 py-2.5 ${j > 0 ? "text-right tabular-nums" : "text-neutral-800"}`}>{c}</td>
                ))}
              </tr>
            ))}
            {raekker.length === 0 && (
              <tr><td colSpan={kolonner.length} className="px-4 py-6 text-center text-neutral-400">Ingen i perioden.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const timer = (t: number | null) => (t == null ? "–" : `${t.toLocaleString("da-DK")} t`);

export default async function DsaRapportSide({
  searchParams,
}: {
  searchParams: Promise<{ fra?: string; til?: string }>;
}) {
  const { admin } = await kraevSideRolle("admin");
  const sp = await searchParams;
  const nu = new Date();
  const aarStart = `${nu.getFullYear()}-01-01`;
  const fraDato = sp.fra && DATO.test(sp.fra) ? sp.fra : aarStart;
  const tilDato = sp.til && DATO.test(sp.til) ? sp.til : isoDato(nu);
  // Til-datoen er med (hele dagen).
  const fra = kbhMidnat(fraDato);
  const naesteDag = new Date(`${tilDato}T12:00:00Z`);
  naesteDag.setUTCDate(naesteDag.getUTCDate() + 1);
  const til = kbhMidnat(naesteDag.toISOString().slice(0, 10));

  const { data, error } = await admin.rpc("dsa_rapport", { p_fra: fra.toISOString(), p_til: til.toISOString() });
  const r = data as Rapport | null;

  const sidsteAar = nu.getFullYear() - 1;
  const forudvalg = [
    { label: "I år", fra: aarStart, til: isoDato(nu) },
    { label: `${sidsteAar}`, fra: `${sidsteAar}-01-01`, til: `${sidsteAar}-12-31` },
    { label: "Sidste 30 dage", fra: isoDato(new Date(nu.getTime() - 30 * 86400000)), til: isoDato(nu) },
  ];

  const kategoriRaekker = (r?.anmeldelser.pr_kategori ?? []).map((k) => [
    anmeldKategoriNavn(k.kategori), k.antal, k.indgreb, k.ingen_overtraedelse, k.ikke_fundet, k.aabne,
  ]);
  const handlingRaekker = (r?.indgreb.pr_handling ?? []).map((h) => [handlingNavn(h.handling), h.antal]);
  const regelRaekker = (r?.indgreb.pr_regel ?? []).map((g) => [
    regelNavn(g.regel), g.grundlag === "lov" ? "Lovgivning" : "BidHamrs regler", g.antal,
  ]);
  const indholdRaekker = (r?.anmeldelser.pr_indhold ?? []).map((x) => [indholdNavn(x.indhold_type), x.antal]);

  const csv: (string | number)[][] = r
    ? [
        ["Afsnit", "Måling", "Værdi"],
        ["Periode", "Fra", fraDato],
        ["Periode", "Til", tilDato],
        ["Anmeldelser", "I alt", r.anmeldelser.i_alt],
        ["Anmeldelser", "Uden login", r.anmeldelser.uden_login],
        ["Anmeldelser", "Åbne", r.anmeldelser.aabne],
        ["Anmeldelser", "Videresendt til admin", r.anmeldelser.videresendt],
        ["Anmeldelser", "Politiet underrettet", r.anmeldelser.politi_underrettet],
        ["Anmeldelser", "Median behandlingstid (timer)", r.anmeldelser.median_timer ?? ""],
        ...r.anmeldelser.pr_kategori.flatMap((k) => [
          ["Anmeldelser pr. kategori", `${anmeldKategoriNavn(k.kategori)} - i alt`, k.antal],
          ["Anmeldelser pr. kategori", `${anmeldKategoriNavn(k.kategori)} - indgreb`, k.indgreb],
          ["Anmeldelser pr. kategori", `${anmeldKategoriNavn(k.kategori)} - ingen overtrædelse`, k.ingen_overtraedelse],
          ["Anmeldelser pr. kategori", `${anmeldKategoriNavn(k.kategori)} - ikke fundet`, k.ikke_fundet],
        ]),
        ...r.anmeldelser.pr_indhold.map((x) => ["Anmeldelser pr. indhold", indholdNavn(x.indhold_type), x.antal]),
        ["Indgreb", "I alt", r.indgreb.i_alt],
        ["Indgreb", "Efter anmeldelse", r.indgreb.efter_anmeldelse],
        ["Indgreb", "På eget initiativ", r.indgreb.eget_initiativ],
        ["Indgreb", "Opdaget automatisk", r.indgreb.automatisk_opdaget],
        ["Indgreb", "Opdaget manuelt", r.indgreb.manuelt_opdaget],
        ["Indgreb", "Afgjort automatisk", r.indgreb.automatisk_afgjort],
        ["Indgreb", "Ophævet senere", r.indgreb.ophaevet],
        ["Indgreb", "Ulovligt indhold (lov)", r.indgreb.pr_grundlag.lov],
        ["Indgreb", "Brud på BidHamrs regler", r.indgreb.pr_grundlag.vilkaar],
        ...r.indgreb.pr_handling.map((h) => ["Indgreb pr. type", handlingNavn(h.handling), h.antal]),
        ...r.indgreb.pr_regel.map((g) => ["Indgreb pr. grund", regelNavn(g.regel), g.antal]),
        ["Suspenderinger", "Midlertidige", r.suspenderinger.midlertidige],
        ["Suspenderinger", "Indtil videre", r.suspenderinger.permanente],
        ["Suspenderinger", "Lukkede konti", r.suspenderinger.lukkede_konti],
        ["Klager", "I alt", r.klager.i_alt],
        ["Klager", "Over indgreb", r.klager.over_indgreb],
        ["Klager", "Fra anmeldere", r.klager.fra_anmeldere],
        ["Klager", "Medhold", r.klager.medhold],
        ["Klager", "Fastholdt", r.klager.fastholdt],
        ["Klager", "Åbne", r.klager.aabne],
        ["Klager", "Median behandlingstid (timer)", r.klager.median_timer ?? ""],
        ["Øvrige rapporter", "Auktioner rapporteret af brugere (app/gammel formular)", r.oevrige_rapporter.auktioner_fra_brugere],
        ["Øvrige rapporter", "Auktioner markeret af automatisk kontrol", r.oevrige_rapporter.auktioner_automatisk],
        ["Øvrige rapporter", "Brugere og bedømmelser rapporteret", r.oevrige_rapporter.brugere_og_bedoemmelser],
        ["Øvrige rapporter", "Beskeder stoppet af spamfilteret", r.oevrige_rapporter.spamfilter],
      ]
    : [];

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <AdminSideHoved
        titel="Gennemsigtighedsrapport"
        forklaring="Tal til den årlige rapport efter EU's forordning om digitale tjenester (DSA artikel 15 og 24): anmeldelser, indgreb, klager og suspenderinger. Ingen persondata – kun antal."
        hoejre={r ? <CsvKnap raekker={csv} filnavn={`bidhamr-dsa-rapport-${fraDato}-${tilDato}.csv`} /> : undefined}
      >
        <Link href="/admin/dsa" className="mt-2 inline-block text-sm font-medium text-groen hover:underline">
          ← Tilbage til anmeldelser og klager
        </Link>
      </AdminSideHoved>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-neutral-200 bg-white p-4">
        <div>
          <label htmlFor="fra" className="block text-xs font-medium text-neutral-600">Fra</label>
          <input id="fra" name="fra" type="date" defaultValue={fraDato} className="mt-1 rounded-lg border border-neutral-200 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="til" className="block text-xs font-medium text-neutral-600">Til og med</label>
          <input id="til" name="til" type="date" defaultValue={tilDato} className="mt-1 rounded-lg border border-neutral-200 px-3 py-2 text-sm" />
        </div>
        <button type="submit" className="rounded-lg bg-orange-knap px-4 py-2 text-sm font-semibold text-white hover:bg-orange-knap-mork">
          Vis
        </button>
        <div className="flex flex-wrap gap-2">
          {forudvalg.map((f) => (
            <Link
              key={f.label}
              href={`/admin/dsa/rapport?fra=${f.fra}&til=${f.til}`}
              className="rounded-full bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-200"
            >
              {f.label}
            </Link>
          ))}
        </div>
      </form>

      {error || !r ? (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Rapporten kunne ikke hentes. Er migrationen 20261009010000_dsa.sql kørt?
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Tal titel="Anmeldelser" vaerdi={r.anmeldelser.i_alt} note={`${r.anmeldelser.uden_login} uden login`} />
            <Tal titel="Median svartid" vaerdi={timer(r.anmeldelser.median_timer)} note="fra anmeldelse til afgørelse" />
            <Tal titel="Indgreb" vaerdi={r.indgreb.i_alt} note={`${r.indgreb.efter_anmeldelse} efter anmeldelse · ${r.indgreb.eget_initiativ} eget initiativ`} />
            <Tal titel="Opdaget automatisk" vaerdi={r.indgreb.automatisk_opdaget} note={`${r.indgreb.manuelt_opdaget} manuelt · ${r.indgreb.automatisk_afgjort} afgjort automatisk`} />
            <Tal titel="Klager" vaerdi={r.klager.i_alt} note={`${r.klager.medhold} medhold · ${r.klager.fastholdt} fastholdt · ${r.klager.aabne} åbne`} />
            <Tal titel="Median klagetid" vaerdi={timer(r.klager.median_timer)} />
            <Tal titel="Suspenderinger" vaerdi={r.suspenderinger.midlertidige + r.suspenderinger.permanente} note={`${r.suspenderinger.midlertidige} midlertidige · ${r.suspenderinger.permanente} indtil videre`} />
            <Tal titel="Lukkede konti" vaerdi={r.suspenderinger.lukkede_konti} />
          </div>

          <Tabel
            titel="Anmeldelser pr. kategori"
            kolonner={["Kategori", "I alt", "Indgreb", "Ingen overtrædelse", "Ikke fundet", "Åbne"]}
            raekker={kategoriRaekker}
          />
          <div className="grid gap-5 lg:grid-cols-2">
            <Tabel titel="Indgreb pr. type" kolonner={["Indgreb", "Antal"]} raekker={handlingRaekker} />
            <Tabel titel="Anmeldelser pr. type indhold" kolonner={["Indhold", "Antal"]} raekker={indholdRaekker} />
          </div>
          <Tabel titel="Indgreb pr. grund" kolonner={["Regel", "Grundlag", "Antal"]} raekker={regelRaekker} />

          <section className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-700">
            <h2 className="text-sm font-semibold text-neutral-800">Øvrige rapporter i perioden</h2>
            <p className="mt-1 text-xs text-neutral-500">Fra appen og det gamle rapport-system, som stadig kører ved siden af.</p>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              <li>Auktioner rapporteret af brugere: <strong>{r.oevrige_rapporter.auktioner_fra_brugere}</strong></li>
              <li>Auktioner markeret af automatisk kontrol: <strong>{r.oevrige_rapporter.auktioner_automatisk}</strong></li>
              <li>Brugere og bedømmelser rapporteret: <strong>{r.oevrige_rapporter.brugere_og_bedoemmelser}</strong></li>
              <li>Beskeder stoppet af spamfilteret: <strong>{r.oevrige_rapporter.spamfilter}</strong></li>
            </ul>
            <p className="mt-3 text-xs text-neutral-500">
              Varer, som forbudte-varer-filteret blokerer ved oprettelse, bliver aldrig offentliggjort og tælles ikke her.
              Videresendt til admin: {r.anmeldelser.videresendt} · politiet underrettet: {r.anmeldelser.politi_underrettet} ·
              indgreb ophævet senere: {r.indgreb.ophaevet}.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
