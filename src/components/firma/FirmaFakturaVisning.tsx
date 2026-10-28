// Forhåndsvisning af en faktura/kreditnota fra firma til køber i HTML -
// samme indhold som PDF'en (src/lib/pdf/firmaFakturaPdf.ts).
import {
  BRUGTMOMS_FAKTURA_TEKST,
  MOMS_SATS,
  adresseLinjer,
  datoTekst,
  dokumentNavn,
  enhedsprisEksklMoms,
  kroner,
  type FirmaFakturaData,
} from "@/lib/erhverv/firmaFaktura";

export default function FirmaFakturaVisning({ d }: { d: FirmaFakturaData }) {
  const kladde = d.status !== "sendt";
  const navn = dokumentNavn(d);
  return (
    <div className="relative overflow-hidden border border-kant bg-white p-5 text-[16px] text-tekst sm:p-8">
      {kladde && (
        <p
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-[80px] font-bold text-black/5 select-none sm:text-[120px]"
          style={{ transform: "rotate(-25deg)" }}
        >
          KLADDE
        </p>
      )}
      <div className="relative flex flex-col gap-6 sm:flex-row sm:justify-between">
        <div>
          <p className="text-[20px] font-semibold">{d.saelger.firmanavn}</p>
          {adresseLinjer(d.saelger).map((l) => (
            <p key={l} className="text-tekst-daempet">
              {l}
            </p>
          ))}
          <p className="text-tekst-daempet">CVR-nr. {d.saelger.cvr}</p>
          {d.saelger.email && <p className="text-tekst-daempet">{d.saelger.email}</p>}
        </div>
        <div className="sm:text-right">
          <p className="text-[26px] font-semibold uppercase">{navn}</p>
          <p>
            {navn}nr.: {d.fakturanummer ?? <em>Gives ved afsendelse</em>}
          </p>
          <p>Fakturadato: {d.udstedt_dato ? datoTekst(d.udstedt_dato) : <em>Dato for afsendelse</em>}</p>
          {d.leveringsdato && <p>Leveringsdato: {datoTekst(d.leveringsdato)}</p>}
          {d.type === "kreditnota" && d.krediterer && (
            <p>
              Krediterer faktura {d.krediterer.fakturanummer}
              {d.krediterer.udstedt_dato ? ` af ${datoTekst(d.krediterer.udstedt_dato)}` : ""}
            </p>
          )}
        </div>
      </div>

      <div className="relative mt-6">
        <p className="font-semibold">Køber</p>
        {d.koeber.firmanavn && <p>{d.koeber.firmanavn}</p>}
        <p>{d.koeber.navn ?? <em className="text-fejl-tekst">Navn mangler</em>}</p>
        {d.koeber.cvr && <p>CVR-nr. {d.koeber.cvr}</p>}
        {adresseLinjer(d.koeber).length > 0 ? (
          adresseLinjer(d.koeber).map((l) => <p key={l}>{l}</p>)
        ) : (
          <p>
            <em className="text-fejl-tekst">Adresse mangler</em>
          </p>
        )}
        {d.koeber.email && <p>{d.koeber.email}</p>}
      </div>

      {d.momsordning === "moms" ? (
        // § 58, stk. 1: enhedspris og beløb ekskl. moms, momssats og beløb inkl. moms pr. linje.
        <div className="relative mt-6 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <thead>
              <tr className="bg-[#F6F7F5] align-bottom">
                <th scope="col" className="px-2 py-2">Beskrivelse</th>
                <th scope="col" className="px-2 py-2 text-right">Antal</th>
                <th scope="col" className="px-2 py-2 text-right">Enhedspris ekskl. moms</th>
                <th scope="col" className="px-2 py-2 text-right">Beløb ekskl. moms</th>
                <th scope="col" className="px-2 py-2 text-right">Moms</th>
                <th scope="col" className="px-2 py-2 text-right">Beløb inkl. moms</th>
              </tr>
            </thead>
            <tbody>
              {d.linjer.map((l, i) => {
                const enhed = enhedsprisEksklMoms(l);
                return (
                  <tr key={i} className="border-b border-kant">
                    <td className="px-2 py-2 break-words">{l.tekst}</td>
                    <td className="px-2 py-2 text-right">{l.antal}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">{enhed === null ? "" : kroner(enhed)}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">{l.netto_oere === null ? "" : kroner(Number(l.netto_oere))}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">{l.moms_sats ?? d.moms_sats ?? MOMS_SATS} %</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">{kroner(l.beloeb_oere)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <table className="relative mt-6 w-full border-collapse text-left">
          <thead>
            <tr className="bg-[#F6F7F5]">
              <th scope="col" className="px-2 py-2">Beskrivelse</th>
              <th scope="col" className="px-2 py-2 text-right">Antal</th>
              <th scope="col" className="px-2 py-2 text-right">Pris</th>
              <th scope="col" className="px-2 py-2 text-right">Beløb</th>
            </tr>
          </thead>
          <tbody>
            {d.linjer.map((l, i) => (
              <tr key={i} className="border-b border-kant">
                <td className="px-2 py-2 break-words">{l.tekst}</td>
                <td className="px-2 py-2 text-right">{l.antal}</td>
                <td className="px-2 py-2 text-right whitespace-nowrap">{kroner(l.enhedspris_oere)}</td>
                <td className="px-2 py-2 text-right whitespace-nowrap">{kroner(l.beloeb_oere)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <dl className="relative mt-4 ml-auto max-w-sm space-y-1">
        {d.momsordning === "moms" && (
          <>
            <div className="flex justify-between gap-4">
              <dt>Beløb ekskl. moms</dt>
              <dd>{kroner(Number(d.beloeb_ekskl_moms_oere ?? 0))}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Moms {d.moms_sats ?? 25} %</dt>
              <dd>{kroner(Number(d.moms_oere ?? 0))}</dd>
            </div>
          </>
        )}
        <div className="flex justify-between gap-4 text-[18px] font-semibold">
          <dt>{d.type === "kreditnota" ? "Krediteret i alt" : "I alt"}</dt>
          <dd>{kroner(Number(d.total_oere))}</dd>
        </div>
      </dl>
      {d.momsordning === "brugtmoms" && (
        <div className="relative mt-3">
          <p className="font-semibold">{d.brugtmoms_tekst ?? BRUGTMOMS_FAKTURA_TEKST}</p>
          {d.brugtmoms_forklaring && <p className="text-[14px] text-tekst-daempet">{d.brugtmoms_forklaring}</p>}
        </div>
      )}
      <p className="relative mt-4">
        {d.type === "kreditnota"
          ? `Kreditnotaen krediterer faktura nr. ${d.krediterer?.fakturanummer ?? ""} fuldt ud.`
          : d.betalingstekst}
      </p>
    </div>
  );
}
