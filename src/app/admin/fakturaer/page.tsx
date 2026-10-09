import { kraevSideRolle } from "@/lib/adminAuth";
import AdminActionKnap from "@/components/admin/AdminActionKnap";
import FakturaHaandterForm from "@/components/admin/FakturaHaandterForm";
import { fakturaHaandteretManuelt, proevFakturaIgen } from "@/app/actions/adminFakturaer";
import { hentFakturaKonfig } from "@/lib/faktura/konfig";

// Fakturaer i Dinero - KUN chef (beløb). Oversigt over køen og de dokumenter,
// der er opgivet (5 fejl) eller stoppet, med "Prøv igen" og "Markér som
// håndteret i Dinero". Se docs/FAKTURA.md.

export const dynamic = "force-dynamic";

export const metadata = { title: "Fakturaer", robots: { index: false, follow: false } };

type Raekke = {
  id: string;
  dokument: string;
  part: string;
  trade_id: string | null;
  beloeb_oere: number;
  status: string;
  manuel: boolean;
  opgivet: boolean;
  forsoeg: number;
  sidste_fejl: string | null;
  dinero_nummer: number | null;
  betalt_dato: string;
  oprettet_kl: string;
};

const kr = (oere: number) =>
  (Number(oere) / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr";

const DOKUMENT: Record<string, string> = {
  faktura: "Faktura",
  kreditnota: "Kreditnota",
  abonnement: "Abonnement (bilag)",
  abonnement_retur: "Abonnement refunderet (bilag)",
};
const PART: Record<string, string> = { koeber: "køber", saelger: "sælger", firma: "firma" };

export default async function AdminFakturaer() {
  const { admin } = await kraevSideRolle("chef");
  const konfig = hentFakturaKonfig();

  const taelle = () => admin.from("fakturaer").select("id", { count: "exact", head: true });
  const [{ data: problemer, error: pFejl }, faerdig, venter, stoppet, manuelt] = await Promise.all([
    admin
      .from("fakturaer")
      .select("id, dokument, part, trade_id, beloeb_oere, status, manuel, opgivet, forsoeg, sidste_fejl, dinero_nummer, betalt_dato, oprettet_kl")
      .or("opgivet.eq.true,status.eq.kraever_handling")
      .not("status", "in", "(faerdig,haandteret_manuelt)")
      .order("oprettet_kl", { ascending: true })
      .limit(200),
    taelle().eq("status", "faerdig"),
    taelle().in("status", ["venter", "kladde", "bogfoert"]).eq("opgivet", false),
    taelle().or("opgivet.eq.true,status.eq.kraever_handling").not("status", "in", "(faerdig,haandteret_manuelt)"),
    taelle().eq("status", "haandteret_manuelt"),
  ]);
  const aFejl = faerdig.error ?? venter.error ?? stoppet.error ?? manuelt.error;
  const tal = {
    faerdig: faerdig.count ?? 0,
    venter: venter.count ?? 0,
    stoppet: stoppet.count ?? 0,
    manuelt: manuelt.count ?? 0,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Fakturaer (Dinero)</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-gray-600">
          BidHamr laver automatisk en faktura til køber (købergebyr, fragt, BidHamr Beskyttelse) og sælger
          (sælgergebyr) ved hver betaling, en kreditnota ved refusion og bogfører betalte abonnementsfakturaer.
          Systemet prøver selv igen ved fejl (5 gange). Her står dem, der kræver dig.
        </p>
        <p className="mt-2 text-sm">
          Dinero:{" "}
          {konfig.ok ? (
            <span className="font-medium text-green-700">
              sat op ({konfig.miljoe === "live" ? "live-regnskab" : "testregnskab"}, organisation {konfig.dinero.orgId})
            </span>
          ) : (
            <span className="font-medium text-red-700">{konfig.besked}</span>
          )}
        </p>
      </div>

      {pFejl || aFejl ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Fakturaerne kunne ikke hentes (er migrationen 20261012080000_fakturaer.sql kørt?).
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Færdige", tal.faerdig],
              ["På vej", tal.venter],
              ["Kræver handling", tal.stoppet],
              ["Håndteret manuelt", tal.manuelt],
            ].map(([t, n]) => (
              <div key={String(t)} className="rounded-lg border border-gray-200 bg-white p-3">
                <dt className="text-xs text-gray-500">{t}</dt>
                <dd className="text-xl font-semibold tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>

          <section className="rounded-lg border border-gray-200 bg-white">
            <h2 className="border-b border-gray-200 px-4 py-3 text-base font-semibold">Kræver handling</h2>
            {(problemer ?? []).length === 0 ? (
              <p className="px-4 py-6 text-sm text-gray-500">Ingen - alle fakturaer kører automatisk.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {((problemer ?? []) as Raekke[]).map((r) => (
                  <li key={r.id} className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">
                        {DOKUMENT[r.dokument] ?? r.dokument} til {PART[r.part] ?? r.part} · {kr(r.beloeb_oere)} ·{" "}
                        {r.betalt_dato}
                        {r.dinero_nummer ? ` · Dinero nr. ${r.dinero_nummer}` : ""}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        Id {r.id}
                        {r.trade_id ? ` · handel ${r.trade_id}` : ""} · {r.opgivet ? `opgivet efter ${r.forsoeg} forsøg` : "stoppet"}
                        {r.manuel ? " · skal laves manuelt" : ""}
                      </p>
                      {r.sidste_fejl && <p className="mt-1 break-words text-red-700">{r.sidste_fejl}</p>}
                    </div>
                    <div className="flex shrink-0 flex-col gap-3 lg:w-72">
                      {!r.manuel && (
                        <AdminActionKnap
                          label="Prøv igen"
                          className="btn btn-primaer btn-lille w-full"
                          action={proevFakturaIgen}
                          hiddenFields={{ id: r.id }}
                        />
                      )}
                      <FakturaHaandterForm id={r.id} action={fakturaHaandteretManuelt} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
