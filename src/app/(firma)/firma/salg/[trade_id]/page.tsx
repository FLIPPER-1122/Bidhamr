import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hentFirmaFakturaer, hentFirmaFakturaSalg, kraevFirma } from "@/lib/erhverv/firmaData";
import FirmaFakturaKnapper from "@/components/firma/FirmaFakturaKnapper";
import { FIRMA_FAKTURA_TEKST, MANGLER_TEKST } from "@/lib/erhverv/firmaFaktura";
import { Kort } from "@/components/firma/dele";
import { FakturaOplysningerListe } from "@/components/firma/FakturaOplysninger";
import { FAKTURA_TEKST } from "@/lib/erhverv/fakturaOplysninger";
import HandelDetalje from "@/components/handel/HandelDetalje";
import { FIRMA_DASHBOARD } from "@/lib/tekster/erhverv";

// En handel inde i firma-dashboardet: samme handelsside som /mine-handler
// (trin, "Send pakke" med pakkebilleder og fragtlabel, kvittering), men uden
// chat (Ingen beskeder med erhvervssælgere). Medlemskab tjekkes i
// HandelDetalje (kun køber/sælger - ellers 404).

export const dynamic = "force-dynamic";
// Fragtlabel (DAO) kan tage op til ca. 50 s i en server action (server.ts: OPRET_MAKS_MS_UDEN_OPSLAG).
export const maxDuration = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const metadata: Metadata = { title: FIRMA_DASHBOARD.salg.titel };

export default async function FirmaHandel({
  params,
  searchParams,
}: {
  params: Promise<{ trade_id: string }>;
  searchParams: Promise<{ ekstrafragt?: string; payment_intent?: string }>;
}) {
  const { trade_id } = await params;
  const { ekstrafragt, payment_intent } = await searchParams;
  await kraevFirma(`/firma/salg/${trade_id}`);
  if (!UUID.test(trade_id)) notFound();
  // Oplysninger til firmaets egen faktura (kun firmaets egne, betalte salg -
  // firma_faktura_salg filtrerer på auth.uid()).
  const [faktura, liste] = await Promise.all([hentFirmaFakturaSalg(null, null, trade_id), hentFirmaFakturaer()]);
  const salg = faktura?.salg[0];
  // Fakturakladden fra firmaet til køberen (sendes kun ved firmaets tryk).
  const kladde = liste?.fakturaer.find((f) => f.trade_id === trade_id && f.type === "faktura");
  return (
    <>
      <HandelDetalje
        trade_id={trade_id}
        sted="firma"
        ekstraFragtParam={typeof ekstrafragt === "string" ? ekstrafragt : undefined}
        ekstraFragtPi={ekstrafragt === "retur" && typeof payment_intent === "string" ? payment_intent : undefined}
      />
      {kladde && (
        <div className="mx-auto mt-6 max-w-3xl">
          <Kort id="firma-faktura" titel={FIRMA_FAKTURA_TEKST.titel} forklaring={FIRMA_FAKTURA_TEKST.intro}>
            <FirmaFakturaKnapper
              id={kladde.id}
              type={kladde.type}
              status={kladde.status}
              fakturanummer={kladde.fakturanummer}
              naesteNummer={liste?.indstillinger.naeste_fakturanummer ?? ""}
              koeberEmail={kladde.data?.koeber.email ?? null}
              mangler={(kladde.data?.mangler ?? []).map((k) => MANGLER_TEKST[k] ?? k)}
              sendtKl={kladde.sendt_kl}
              mailFejl={kladde.mail_fejl}
              mailSendtKl={kladde.mail_sendt_kl}
              kreditnotaId={kladde.kreditnota_id}
            />
          </Kort>
        </div>
      )}
      {faktura && salg && (
        <div className="mx-auto mt-6 max-w-3xl">
          <Kort id="faktura-oplysninger" titel={FAKTURA_TEKST.titel} forklaring={FAKTURA_TEKST.forklaring}>
            <FakturaOplysningerListe salg={salg} firma={faktura.firma} />
          </Kort>
        </div>
      )}
    </>
  );
}
