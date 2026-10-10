import Link from "next/link";
import { kraevSideRolle } from "@/lib/adminAuth";
import { krypteringKlar } from "@/lib/dac7/krypto";
import { indberetningsfrist, kr } from "@/lib/dac7/regler";
import AdminSideHoved from "@/components/admin/AdminSideHoved";
import { Dac7FilKnap, Dac7IndstillingerForm, Dac7SendtForm, type Dac7Eksport } from "@/components/admin/Dac7Handlinger";

// DAC7 - indberetning af sælgere til Skattestyrelsen. KUN chef (beløb og
// skatteoplysninger). Viser pr. år de sælgere, der skal indberettes eller
// nærmer sig grænsen, status for deres oplysninger, filen i Skattestyrelsens
// format og "Sendt til Skattestyrelsen". Ingen CPR-numre på siden - kun i
// filen. Se docs/DAC7.md.

export const dynamic = "force-dynamic";

export const metadata = { title: "DAC7", robots: { index: false, follow: false } };

type Saelger = {
  bruger_id: string;
  navn: string | null;
  konto_type: "privat" | "erhverv";
  slettet: boolean;
  antal: number;
  vederlag_oere: number;
  gebyr_oere: number;
  pligtig: boolean;
  naer: boolean;
  mangler: string[];
  anmodet_kl: string | null;
  frist: string | null;
  paamindelser: number;
  spaerret: boolean;
  opfyldt_kl: string | null;
  indberettet_kl: string | null;
};

type Oversigt = {
  kode: string;
  aar: number;
  kurs: number;
  sendt_kl: string | null;
  kvittering: string | null;
  platform: {
    cvr: string | null;
    navn: string | null;
    vej: string | null;
    postnummer: string | null;
    bynavn: string | null;
    kontakt: string | null;
  } | null;
  saelgere: Saelger[];
  eksporter?: Dac7Eksport[];
};

const MANGLER: Record<string, string> = {
  mitid: "MitID (navn/fødselsdato)",
  oplysninger: "adresse og CPR",
  firma: "firmaets CVR/adresse",
};

const dato = (iso: string) =>
  new Date(iso).toLocaleDateString("da-DK", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Copenhagen" });

function statusTekst(s: Saelger): { tekst: string; farve: string } {
  if (s.mangler.length === 0) return { tekst: "Komplet", farve: "text-succes-tekst" };
  const hvad = s.mangler.map((m) => MANGLER[m] ?? m).join(", ");
  if (s.spaerret) return { tekst: `Mangler ${hvad} · spærret for nye auktioner`, farve: "text-fejl-tekst" };
  if (s.anmodet_kl)
    return {
      tekst: `Mangler ${hvad} · bedt om det ${dato(s.anmodet_kl)}${s.paamindelser ? `, ${s.paamindelser} påmindelse(r)` : ""} · frist ${s.frist ? dato(s.frist) : "–"}`,
      farve: "text-advarsel-tekst",
    };
  return { tekst: `Mangler ${hvad}`, farve: "text-advarsel-tekst" };
}

export default async function AdminDac7({ searchParams }: { searchParams: Promise<{ aar?: string }> }) {
  const { userId, admin } = await kraevSideRolle("chef");
  const nu = Number(new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Copenhagen" }).slice(0, 4));
  const { aar: aarParam } = await searchParams;
  const valgt = Number(aarParam);
  const aar = Number.isInteger(valgt) && valgt >= 2023 && valgt <= nu ? valgt : nu - 1 >= 2026 ? nu - 1 : nu;

  const { data, error } = await admin.rpc("dac7_admin_oversigt", { p_medarbejder: userId, p_aar: aar });
  const o = (data ?? null) as Oversigt | null;
  const aarListe = Array.from({ length: Math.max(1, nu - 2025) }, (_, i) => nu - i).filter((a) => a >= 2026);
  if (!aarListe.includes(aar)) aarListe.push(aar);

  if (error || !o || o.kode !== "ok") {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <h1 className="text-2xl font-bold text-neutral-900">DAC7</h1>
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          Oversigten kunne ikke hentes (er migrationen 20261014010000_dac7.sql kørt?).
        </p>
      </div>
    );
  }

  const pligtige = o.saelgere.filter((s) => s.pligtig);
  const naer = o.saelgere.filter((s) => !s.pligtig && s.naer);
  const ufuldstaendige = pligtige.filter((s) => s.mangler.length > 0).length;
  const aaretSlut = aar < nu;
  const p = o.platform;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <AdminSideHoved
        titel="DAC7 – indberetning til Skattestyrelsen"
        forklaring={
          <>
          Sælgere med mindst 30 salg eller over 2.000 EUR i et kalenderår skal indberettes senest{" "}
          <strong>{indberetningsfrist(aar)}</strong> (TastSelv Erhverv → Øvrige indberetninger → Platformsøkonomi).
          Vederlag = det, sælgeren fik efter sælgergebyr; gebyr = sælgergebyret. Kurs {String(o.kurs).replace(".", ",")}{" "}
          DKK/EUR (grænse {kr(Math.round(2000 * o.kurs * 100))}). Se docs/DAC7.md.
          </>
        }
      >
        <nav className="mt-3 flex flex-wrap gap-2 text-sm" aria-label="Vælg år">
          {aarListe
            .sort((a, b) => b - a)
            .map((a) => (
              <Link
                key={a}
                href={`/admin/dac7?aar=${a}`}
                aria-current={a === aar ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-full border px-4 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen ${
                  a === aar ? "border-groen bg-groen text-white" : "border-kant-staerk bg-white text-tekst hover:bg-groen-lys"
                }`}
              >
                {a}
              </Link>
            ))}
        </nav>
      </AdminSideHoved>

      {!krypteringKlar() && (
        <p role="alert" className="rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          DAC7_KRYPTERINGSNOEGLE mangler på serveren. Sælgerne kan ikke gemme CPR, og filen kan ikke laves.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Skal indberettes", pligtige.length],
          ["Mangler oplysninger", ufuldstaendige],
          ["Nærmer sig grænsen", naer.length],
          ["Status", o.sendt_kl ? `Sendt ${dato(o.sendt_kl)}` : aaretSlut ? "Ikke sendt" : "Året er i gang"],
        ].map(([t, n]) => (
          <div key={String(t)} className="rounded-xl border border-kant bg-white p-4">
            <dt className="text-[13px] text-tekst-daempet">{t}</dt>
            <dd className="mt-0.5 text-lg leading-tight font-bold tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>

      <section className="rounded-[14px] border border-kant bg-white">
        <h2 className="border-b border-kant px-4 py-3 text-base font-semibold">
          Skal indberettes for {aar} ({pligtige.length})
        </h2>
        {pligtige.length === 0 ? (
          <p className="px-4 py-3 text-sm text-tekst-daempet">Ingen sælgere har nået grænsen.</p>
        ) : (
          <SaelgerTabel saelgere={pligtige} />
        )}
      </section>

      {naer.length > 0 && (
        <section className="rounded-[14px] border border-kant bg-white">
          <h2 className="border-b border-kant px-4 py-3 text-base font-semibold">
            Nærmer sig grænsen ({naer.length})
          </h2>
          <p className="px-4 pt-3 text-sm text-tekst-daempet">
            Private sælgere bliver automatisk bedt om oplysningerne med 60 dages frist (påmindelser efter 20 og 40
            dage). Derefter kan de ikke oprette nye auktioner, før oplysningerne er givet.
          </p>
          <SaelgerTabel saelgere={naer} />
        </section>
      )}

      <section className="rounded-[14px] border border-kant bg-white p-4">
        <h2 className="text-base font-semibold">Indberetning for {aar}</h2>
        {o.sendt_kl ? (
          <p className="mt-2 text-sm text-succes-tekst">
            Markeret som sendt {dato(o.sendt_kl)} (kvittering {o.kvittering}). Sælgerne har fået en kopi under Min
            konto.
          </p>
        ) : (
          <ol className="mt-2 list-decimal space-y-3 pl-5 text-sm">
            <li>
              Tjek, at BidHamrs oplysninger herunder er udfyldt, og at alle sælgere er komplette. Mangler der noget,
              bruges Skattestyrelsens dummy-værdier (fx fødselsdato 01-01-1900), og indberetningen skal rettes senere.
            </li>
            <li>
              <Dac7FilKnap aar={aar} deaktiveret={!p?.cvr} />
              {!aaretSlut && <p className="mt-1 text-xs text-tekst-svag">Året er ikke slut – filen er kun en prøve.</p>}
            </li>
            <li>Upload filen i TastSelv Erhverv og vent på, at valideringen er godkendt. Slet filen bagefter.</li>
            <li>{aaretSlut ? <Dac7SendtForm aar={aar} eksporter={o.eksporter ?? []} /> : "Markér som sendt, når året er slut og filen er uploadet."}</li>
          </ol>
        )}
      </section>

      <section className="rounded-[14px] border border-kant bg-white p-4">
        <h2 className="text-base font-semibold">Indstillinger</h2>
        <p className="mt-1 text-sm text-tekst-daempet">
          BidHamr som platformsoperatør (står i filen) og årets kurs. Kursen kan ikke ændres, når året er sendt.
        </p>
        <div className="mt-3">
          <Dac7IndstillingerForm
            aar={aar}
            kurs={o.kurs}
            cvr={p?.cvr ?? ""}
            navn={p?.navn ?? ""}
            vej={p?.vej ?? ""}
            postnummer={p?.postnummer ?? ""}
            bynavn={p?.bynavn ?? ""}
            kontakt={p?.kontakt ?? ""}
            laast={!!o.sendt_kl}
          />
        </div>
      </section>
    </div>
  );
}

function SaelgerTabel({ saelgere }: { saelgere: Saelger[] }) {
  return (
    <>
      {/* Mobil: ét kort pr. sælger (ingen vandret scroll). */}
      <ul className="divide-y divide-kant sm:hidden">
        {saelgere.map((s) => {
          const st = statusTekst(s);
          return (
            <li key={s.bruger_id} className="px-4 py-3 text-sm">
              <SaelgerNavn s={s} />
              <dl className="mt-1.5 grid grid-cols-3 gap-2 tabular-nums">
                <div>
                  <dt className="text-[12px] text-tekst-svag">Salg</dt>
                  <dd>{s.antal}</dd>
                </div>
                <div>
                  <dt className="text-[12px] text-tekst-svag">Vederlag</dt>
                  <dd>{kr(s.vederlag_oere)}</dd>
                </div>
                <div>
                  <dt className="text-[12px] text-tekst-svag">Gebyr</dt>
                  <dd>{kr(s.gebyr_oere)}</dd>
                </div>
              </dl>
              <p className={`mt-1.5 ${st.farve}`}>{st.tekst}</p>
              {s.indberettet_kl && <p className="text-[12px] text-tekst-svag">Indberettet {dato(s.indberettet_kl)}</p>}
            </li>
          );
        })}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-left text-sm">
          <thead className="text-[13px] text-tekst-svag">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Sælger</th>
              <th scope="col" className="px-4 py-2 font-medium">Salg</th>
              <th scope="col" className="px-4 py-2 font-medium">Vederlag</th>
              <th scope="col" className="px-4 py-2 font-medium">Gebyr</th>
              <th scope="col" className="px-4 py-2 font-medium">Oplysninger</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-kant">
            {saelgere.map((s) => {
              const st = statusTekst(s);
              return (
                <tr key={s.bruger_id}>
                  <td className="px-4 py-2">
                    <SaelgerNavn s={s} />
                  </td>
                  <td className="px-4 py-2 tabular-nums">{s.antal}</td>
                  <td className="px-4 py-2 whitespace-nowrap tabular-nums">{kr(s.vederlag_oere)}</td>
                  <td className="px-4 py-2 whitespace-nowrap tabular-nums">{kr(s.gebyr_oere)}</td>
                  <td className={`px-4 py-2 ${st.farve}`}>
                    {st.tekst}
                    {s.indberettet_kl && (
                      <span className="block text-[12px] text-tekst-svag">Indberettet {dato(s.indberettet_kl)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SaelgerNavn({ s }: { s: Saelger }) {
  return (
    <>
      <Link
        href={`/admin/brugere/${s.bruger_id}`}
        className="font-medium text-groen hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        {s.navn ?? "Ukendt"}
      </Link>
      {s.konto_type === "erhverv" && <span className="ml-2 text-[12px] text-tekst-svag">firma</span>}
      {s.slettet && <span className="ml-2 text-[12px] text-tekst-svag">slettet konto</span>}
    </>
  );
}
