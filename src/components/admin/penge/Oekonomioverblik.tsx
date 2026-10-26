import Link from "next/link";
import { loesPengeAfvigelse } from "@/app/actions/adminPenge";
import {
  forrigeMaaned,
  naesteMaaned,
  POSTERING_NAVN,
  type Oekonomi,
  type Postering,
} from "@/lib/admin/pengeOekonomi";

// Økonomioverblikket øverst i Admin -> Penge (KUN chef - siden og
// hentOekonomi tjekker rollen). Server component; formularerne bruger
// server actions (adminPenge.ts). Viser kun tal - intet her flytter penge.

const kr = (oere: number | null | undefined) =>
  oere === null || oere === undefined
    ? "–"
    : (oere / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr";

const dato = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("da-DK", { timeZone: "Europe/Copenhagen", dateStyle: "short", timeStyle: "short" })
    : "–";

const MAANEDER = [
  "januar", "februar", "marts", "april", "maj", "juni",
  "juli", "august", "september", "oktober", "november", "december",
];

function maanedNavn(m: string): string {
  const [aar, md] = m.split("-").map(Number);
  return `${MAANEDER[md - 1]} ${aar}`;
}

const BESKED: Record<string, { tekst: string; fejl?: boolean }> = {
  loest: { tekst: "Afvigelsen er markeret som løst." },
  ugyldig: { tekst: "Ugyldige værdier - tjek felterne.", fejl: true },
  note_mangler: { tekst: "Skriv en note om, hvad der er gjort.", fejl: true },
  for_lang: { tekst: "Noten er for lang (højst 1.000 tegn).", fejl: true },
  ikke_fundet: { tekst: "Afvigelsen findes ikke eller er allerede løst.", fejl: true },
  ingen_adgang: { tekst: "Kun chefen kan ændre dette.", fejl: true },
  fejl: { tekst: "Noget gik galt. Prøv igen om lidt.", fejl: true },
};

const AFVIGELSE_NAVN: Record<string, string> = {
  ukendt_betaling: "Ukendt betaling hos Stripe",
  betaling_status: "Betalingsstatus passer ikke",
  betaling_beloeb: "Beløb passer ikke",
  gebyr: "Gebyr passer ikke",
  ukendt_gebyr: "Ukendt gebyr",
  refusion_udenom: "Refusion uden om BidHamr",
  tilbagefoersel_udenom: "Tilbageførsel uden om BidHamr",
  udbetaling_ukendt: "Udbetaling, BidHamr ikke har lavet",
  udbetaling_afviger: "Udbetaling passer ikke",
  udbetaling_mangler: "Udbetaling findes ikke hos Stripe",
  abonnement_indsigelse: "Indsigelse på abonnement",
  ukendt_indsigelse: "Ukendt indsigelse",
  gebyrsum: "Summen af gebyrer passer ikke",
};

function Boks({ titel, vaerdi, under, tone }: { titel: string; vaerdi: string; under?: string; tone?: "groen" | "orange" | "roed" }) {
  const farve = tone === "groen" ? "text-green-700" : tone === "orange" ? "text-orange-700" : tone === "roed" ? "text-red-700" : "text-neutral-900";
  return (
    <div className="min-w-0 rounded-xl border border-neutral-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{titel}</p>
      <p className={`mt-1 break-words text-xl font-bold tabular-nums ${farve}`}>{vaerdi}</p>
      {under && <p className="mt-1 text-xs text-neutral-500">{under}</p>}
    </div>
  );
}

function Linje({ label, vaerdi, fremhaev }: { label: string; vaerdi: string; fremhaev?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-1.5 text-sm ${fremhaev ? "border-t border-neutral-200 font-semibold" : ""}`}>
      <span className="min-w-0 text-neutral-700">{label}</span>
      <span className="shrink-0 tabular-nums text-neutral-900">{vaerdi}</span>
    </div>
  );
}

function Fejl({ tekst }: { tekst: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
      {tekst}
    </div>
  );
}

function PosteringRaekke({ p }: { p: Postering }) {
  return (
    <tr className="border-t border-neutral-100 align-top">
      <td className="whitespace-nowrap py-2 pr-3 text-neutral-600">{dato(p.kl)}</td>
      <td className="py-2 pr-3">
        <span className="text-neutral-900">{POSTERING_NAVN[p.type] ?? p.type}</span>
        {p.titel && <span className="block max-w-[16rem] truncate text-xs text-neutral-500">{p.titel}</span>}
      </td>
      <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums">{kr(p.beloeb_oere)}</td>
      <td
        className={`whitespace-nowrap py-2 text-right tabular-nums ${
          p.bidhamr_oere > 0 ? "text-green-700" : p.bidhamr_oere < 0 ? "text-red-700" : "text-neutral-400"
        }`}
      >
        {p.bidhamr_oere === 0 ? "–" : `${p.bidhamr_oere > 0 ? "+" : ""}${kr(p.bidhamr_oere)}`}
      </td>
    </tr>
  );
}

export default function Oekonomioverblik({ o, besked }: { o: Oekonomi; besked?: string }) {
  const r = o.overblik.ok ? o.overblik.data : null;
  const b = o.balance.ok ? o.balance.data : null;
  const t = o.tal.ok ? o.tal.data : null;
  const f = o.fragt.ok ? o.fragt.data : null;
  const fragtKost = f ? (f.fragtfirma_pris_inkl_moms_oere > 0 ? f.fragtfirma_pris_inkl_moms_oere : f.forventet_kost_inkl_moms_oere) : null;
  const msg = besked ? BESKED[besked] : undefined;

  return (
    <section id="oekonomi" className="space-y-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-neutral-900">Økonomioverblik</h2>
          <p className="text-xs text-neutral-500">
            Pengene står hos vores betalingspartner Stripe. Købers penge står på sælgerens Stripe-konto, til de
            udbetales; platformens saldo er BidHamrs gebyrer. Kun tal - intet her flytter penge.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link href={`/admin/penge?maaned=${forrigeMaaned(o.maaned)}#oekonomi`} className="rounded-md bg-white px-2 py-1 text-neutral-700 shadow-sm hover:text-neutral-900">
            ← Forrige
          </Link>
          <span className="font-medium capitalize text-neutral-900">{maanedNavn(o.maaned)}</span>
          <Link href={`/admin/penge?maaned=${naesteMaaned(o.maaned)}#oekonomi`} className="rounded-md bg-white px-2 py-1 text-neutral-700 shadow-sm hover:text-neutral-900">
            Næste →
          </Link>
          <a
            href={`/admin/penge/csv?maaned=${o.maaned}`}
            className="rounded-md bg-neutral-900 px-3 py-1.5 font-medium text-white hover:bg-neutral-700"
          >
            Download måneden (CSV)
          </a>
        </div>
      </div>

      {msg && (
        <div
          className={`rounded-lg px-4 py-2 text-sm ${msg.fejl ? "border border-red-200 bg-red-50 text-red-800" : "border border-green-200 bg-green-50 text-green-800"}`}
          role={msg.fejl ? "alert" : "status"}
        >
          {msg.tekst}
        </div>
      )}

      {!o.balance.ok && <Fejl tekst={`Stripe-saldoen kunne ikke hentes: ${o.balance.fejl}`} />}
      {!o.overblik.ok && <Fejl tekst={o.overblik.fejl} />}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Boks
          titel="BidHamrs saldo hos Stripe"
          vaerdi={b ? kr(b.tilgaengelig) : "–"}
          under={b ? `Tilgængelig · ${kr(b.afventer)} afventende` : r?.snapshot ? `Senest kendt ${dato(r.snapshot.kl)}: ${kr(r.snapshot.tilgaengelig_oere)}` : undefined}
          tone="groen"
        />
        <Boks
          titel="Sælgernes penge hos Stripe"
          vaerdi={r ? kr(r.saelgere.oere) : "–"}
          under={
            r
              ? `${r.saelgere.antal_handler} handler på ${r.saelgere.konti} sælgerkonti, ikke udbetalt${
                  r.paa_vej_til_bank.antal ? ` · ${kr(r.paa_vej_til_bank.oere)} på vej til bank` : ""
                }`
              : undefined
          }
          tone="orange"
        />
        <Boks
          titel="Skal betales tilbage til købere"
          vaerdi={r ? kr(r.skylder_koebere_oere) : "–"}
          under="Refusioner i gang og forkerte beløb - dækkes af BidHamrs saldo"
        />
        <Boks
          titel="Kan trækkes ud nu"
          vaerdi={r ? kr(r.kan_traekkes_ud_oere) : "–"}
          under="Tilgængelig saldo minus refusioner i gang"
          tone="groen"
        />
      </div>

      {r?.snapshot?.saelgere_stripe_oere !== null && r?.snapshot?.saelgere_stripe_oere !== undefined && r.snapshot.kilde === "afstemning" && (
        <p className="text-xs text-neutral-500">
          Afstemningen {dato(r.snapshot.kl)}: sælgernes Stripe-saldi i alt {kr(r.snapshot.saelgere_stripe_oere)} på{" "}
          {r.snapshot.saelgerkonti} konti (databasen siger {kr(r.saelgere.oere)} nu).
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <h3 className="mb-1 font-semibold text-neutral-900">Måneden: {maanedNavn(o.maaned)}</h3>
          {!o.tal.ok && <Fejl tekst={o.tal.fejl} />}
          {t && (
            <>
              <Linje label="Gebyrer" vaerdi={kr(t.indtjening.i_alt)} />
              <Linje label={`Refusioner (${t.refusioner.fulde.antal + t.refusioner.delvise.antal})`} vaerdi={kr(t.refusioner.fulde.beloeb + t.refusioner.delvise.beloeb)} />
              <Linje label={`Indsigelser (${t.indsigelser.antal}, heraf ${t.indsigelser.aabne} åbne)`} vaerdi={kr(t.indsigelser.beloeb)} />
              <Linje label={`Tab ved indsigelser efter udbetaling (${t.indsigelser.tabt_efter_udbetaling.antal})`} vaerdi={kr(t.indsigelser.tabt_efter_udbetaling.tab)} />
              <Linje label="Fragt betalt af købere" vaerdi={kr(t.fragt.beloeb)} />
              {f && fragtKost !== null && (
                <>
                  <Linje label={`Fragtfirmaets pris (DAO)${f.uden_kostpris ? ` - ${f.uden_kostpris} uden kostpris` : ""}`} vaerdi={`- ${kr(fragtKost)}`} />
                  <Linje label="Fragt netto" vaerdi={kr(f.koeber_betalt_oere - fragtKost)} fremhaev />
                </>
              )}
            </>
          )}
        </div>

        <div className="rounded-xl border border-neutral-200 bg-white p-4">
          <h3 className="mb-1 font-semibold text-neutral-900">Seneste posteringer</h3>
          {!o.posteringer.ok && <Fejl tekst={o.posteringer.fejl} />}
          {o.posteringer.ok && o.posteringer.data.length === 0 && <p className="text-sm text-neutral-500">Ingen posteringer endnu.</p>}
          {o.posteringer.ok && o.posteringer.data.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-1 pr-3 font-medium">Tid</th>
                    <th className="py-1 pr-3 font-medium">Postering</th>
                    <th className="py-1 pr-3 text-right font-medium">Beløb</th>
                    <th className="py-1 text-right font-medium">BidHamr</th>
                  </tr>
                </thead>
                <tbody>
                  {o.posteringer.data.map((p, i) => (
                    <PosteringRaekke key={`${p.type}-${p.betaling_id ?? p.stripe_id}-${i}`} p={p} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-4">
        <h3 className="font-semibold text-neutral-900">Daglig afstemning med Stripe</h3>
        {r?.afstemning.seneste_koersel ? (
          <p className="text-sm text-neutral-700">
            Seneste kørsel {dato(r.afstemning.seneste_koersel.startet_kl)}:{" "}
            {r.afstemning.seneste_koersel.afsluttet_kl === null
              ? "kører stadig (eller blev afbrudt)"
              : !r.afstemning.seneste_koersel.ok
                ? "fejlede - se /admin/drift"
                : r.afstemning.seneste_koersel.ufuldstaendig
                  ? `Ufuldstændig – ${Number(r.afstemning.seneste_koersel.resultat?.trinIkkeNaaet ?? 0)} trin ikke nået (fortsætter inden for 2 timer) · ${r.afstemning.seneste_koersel.antal_afvigelser} afvigelse(r)`
                  : `ok · ${r.afstemning.seneste_koersel.antal_afvigelser} afvigelse(r), ${r.afstemning.seneste_koersel.antal_nye} nye`}
          </p>
        ) : (
          <p className="text-sm text-neutral-500">Afstemningen har ikke kørt endnu (den kører én gang i døgnet).</p>
        )}
        {!o.afvigelser.ok && <Fejl tekst={o.afvigelser.fejl} />}
        {o.afvigelser.ok && o.afvigelser.data.length === 0 && (
          <p className="mt-1 text-sm text-green-700">Ingen åbne afvigelser - Stripe og databasen passer sammen.</p>
        )}
        {o.afvigelser.ok && o.afvigelser.data.length > 0 && (
          <ul className="mt-2 space-y-3">
            {o.afvigelser.data.map((a) => (
              <li key={a.id} className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
                <p className="font-medium text-red-900">{AFVIGELSE_NAVN[a.type] ?? a.type}</p>
                <p className="mt-0.5 break-words text-red-800">{a.beskrivelse}</p>
                <p className="mt-0.5 text-xs text-red-700">
                  Stripe: {kr(a.beloeb_stripe_oere)} · Databasen: {kr(a.beloeb_db_oere)} · Først set {dato(a.foerst_set_kl)} · set {a.antal_set} gang(e)
                </p>
                <form action={loesPengeAfvigelse} className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input type="hidden" name="id" value={a.id} />
                  <label className="sr-only" htmlFor={`note-${a.id}`}>Note</label>
                  <input
                    id={`note-${a.id}`}
                    name="note"
                    required
                    maxLength={1000}
                    placeholder="Hvad er gjort? (kræves)"
                    className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm"
                  />
                  <button type="submit" className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700">
                    Markér som løst
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>

    </section>
  );
}
