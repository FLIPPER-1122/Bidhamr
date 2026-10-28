import Link from "next/link";
import { hentFirmaFakturaer, kraevFirma } from "@/lib/erhverv/firmaData";
import { FirmaSide, Kort, StatusMaerke } from "@/components/firma/dele";
import { E_KNAP_SEKUNDAER, E_LABEL, E_TEKST, E_TEKST_DAEMPET, eFelt } from "@/components/erhverv/stil";
import FirmaFakturaKnapper from "@/components/firma/FirmaFakturaKnapper";
import { FIRMA_FAKTURA_TEKST as T, MANGLER_TEKST, kroner } from "@/lib/erhverv/firmaFaktura";

// Fakturaer fra firmaet til køberne: alle kladder, sendte fakturaer og
// kreditnotaer + eksport til regnskabet. Intet sendes uden firmaets tryk.

export const dynamic = "force-dynamic";
export const metadata = { title: T.titel };

export default async function FirmaFakturaerSide() {
  await kraevFirma("/firma/fakturaer");
  const liste = await hentFirmaFakturaer();
  const fakturaer = liste?.fakturaer ?? [];
  const naeste = liste?.indstillinger.naeste_fakturanummer ?? "";
  const idag = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Copenhagen" });
  const aarStart = `${idag.slice(0, 4)}-01-01`;

  return (
    <FirmaSide titel={T.titel} intro={T.intro}>
      <div>
        <Link href="/firma/fakturaer/indstillinger" className={E_KNAP_SEKUNDAER}>
          {T.indstillinger}
        </Link>
      </div>
      <Kort id="fakturaer" titel={T.liste}>
        {fakturaer.length === 0 ? (
          <p className={E_TEKST}>{T.listeTom}</p>
        ) : (
          <ul className="space-y-4">
            {fakturaer.map((f) => {
              const d = f.data;
              const kredit = f.type === "kreditnota";
              return (
                <li key={f.id} className="border-2 border-kant p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[19px] font-semibold break-words text-tekst">
                        {kredit ? "Kreditnota" : "Faktura"} {f.fakturanummer ?? ""}
                        {d?.linjer[0] ? ` · ${d.linjer[0].tekst}` : ""}
                      </p>
                      <p className={E_TEKST_DAEMPET}>
                        {d?.koeber.navn ?? "Køber"} · {d ? kroner(Number(d.total_oere)) : ""}
                        {kredit && d?.krediterer?.fakturanummer ? ` · krediterer ${d.krediterer.fakturanummer}` : ""}
                      </p>
                    </div>
                    <StatusMaerke
                      tekst={f.status === "sendt" ? "Sendt" : T.kladde}
                      farve={f.status === "sendt" ? "border-succes-kant bg-succes-bg text-succes-tekst" : "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst"}
                    />
                  </div>
                  <div className="mt-3">
                    <FirmaFakturaKnapper
                      id={f.id}
                      type={f.type}
                      status={f.status}
                      fakturanummer={f.fakturanummer}
                      naesteNummer={naeste}
                      koeberEmail={d?.koeber.email ?? null}
                      mangler={(d?.mangler ?? []).map((k) => MANGLER_TEKST[k] ?? k)}
                      sendtKl={f.sendt_kl}
                      mailFejl={f.mail_fejl}
                      mailSendtKl={f.mail_sendt_kl}
                      kreditnotaId={f.kreditnota_id}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Kort>

      <Kort id="eksport" titel={T.eksportTitel} forklaring={T.eksportForklaring}>
        <form action="/firma/fakturaer/eksport" method="GET" className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ff-fra" className={E_LABEL}>
              Fra og med
            </label>
            <input id="ff-fra" name="fra" type="date" required defaultValue={aarStart} max={idag} className={eFelt()} />
          </div>
          <div>
            <label htmlFor="ff-til" className={E_LABEL}>
              Til og med
            </label>
            <input id="ff-til" name="til" type="date" required defaultValue={idag} className={eFelt()} />
          </div>
          <div className="flex flex-wrap gap-3 sm:col-span-2">
            <button type="submit" name="format" value="csv" className={E_KNAP_SEKUNDAER}>
              {T.eksportCsv}
            </button>
            <button type="submit" name="format" value="zip" className={E_KNAP_SEKUNDAER}>
              {T.eksportZip}
            </button>
          </div>
        </form>
      </Kort>
    </FirmaSide>
  );
}
