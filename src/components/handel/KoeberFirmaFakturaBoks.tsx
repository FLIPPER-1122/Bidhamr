import { createClient } from "@/lib/supabase/server";
import { datoTekst, kroner } from "@/lib/erhverv/firmaFaktura";
import KoeberFirmaForm from "@/components/handel/KoeberFirmaForm";

// Købers side af en handel med et firma: fakturaen på varen, som FIRMAET har
// udstedt og sendt (kun sendte vises), og - indtil den er sendt - mulighed
// for at oplyse sit eget firmanavn og CVR til fakturaen.

type Svar = {
  kladde: { firmanavn: string | null; cvr: string | null } | null;
  fakturaer: { id: string; type: string; fakturanummer: string; udstedt_dato: string; firmanavn: string; total_oere: number }[];
} | null;

export default async function KoeberFirmaFakturaBoks({ tradeId }: { tradeId: string }) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("koeber_firma_fakturaer", { p_trade: tradeId });
  if (error) return null;
  const d = data as Svar;
  if (!d || (!d.kladde && d.fakturaer.length === 0)) return null;
  return (
    <section aria-labelledby={`firma-faktura-${tradeId}`} className="rounded-none border border-kant bg-white p-5 sm:p-6">
      <h2 id={`firma-faktura-${tradeId}`} className="text-[17px] leading-snug lg:text-lg">
        Faktura fra sælger
      </h2>
      {d.fakturaer.length === 0 ? (
        <p className="mt-1 text-sm text-tekst-daempet">Sælgeren har ikke sendt en faktura på varen endnu. Du får den på mail, når den er sendt.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {d.fakturaer.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {f.type === "kreditnota" ? "Kreditnota" : "Faktura"} nr. {f.fakturanummer} fra {f.firmanavn} · {datoTekst(f.udstedt_dato)} ·{" "}
                {kroner(Number(f.total_oere))}
              </span>
              <a href={`/api/firma-faktura/${f.id}?download=1`} className="font-semibold text-groen underline underline-offset-2">
                Download PDF
              </a>
            </li>
          ))}
        </ul>
      )}
      {d.kladde && <KoeberFirmaForm tradeId={tradeId} firmanavn={d.kladde.firmanavn} cvr={d.kladde.cvr} />}
    </section>
  );
}
