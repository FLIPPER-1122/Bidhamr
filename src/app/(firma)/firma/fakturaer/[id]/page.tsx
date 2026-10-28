import { notFound } from "next/navigation";
import { kraevFirma } from "@/lib/erhverv/firmaData";
import { createClient } from "@/lib/supabase/server";
import { logDriftFejl } from "@/lib/drift";
import { FirmaSide, Kort } from "@/components/firma/dele";
import { E_HJAELP, E_KNAP_SEKUNDAER } from "@/components/erhverv/stil";
import FirmaFakturaVisning from "@/components/firma/FirmaFakturaVisning";
import FirmaFakturaKnapper from "@/components/firma/FirmaFakturaKnapper";
import FirmaFakturaKladdeForm from "@/components/firma/FirmaFakturaKladdeForm";
import { FIRMA_FAKTURA_TEKST as T, MANGLER_TEKST, dokumentNavn, type FirmaFakturaData } from "@/lib/erhverv/firmaFaktura";
import { ADRESSE_KILDE_TEKST, hentKoeberFakturaOplysninger } from "@/lib/erhverv/koeberFakturaOplysninger";

// "Se din faktura": forhåndsvisning (kladde) eller den sendte faktura, med
// "Send" (bekræftelse), ret kladden, "Download PDF" og "Lav kreditnota".

export const dynamic = "force-dynamic";
export const metadata = { title: T.titel };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Hent = {
  id: string;
  type: "faktura" | "kreditnota";
  status: "kladde" | "sendt";
  trade_id: string;
  kreditnota_id: string | null;
  fakturanummer: string | null;
  sendt_kl: string | null;
  mail_sendt_kl: string | null;
  mail_fejl: string | null;
  naeste_fakturanummer: string;
  rettelser: {
    koeber_navn: string | null;
    koeber_adresse: string | null;
    koeber_postnummer: string | null;
    koeber_by: string | null;
    koeber_email: string | null;
    koeber_firmanavn: string | null;
    koeber_cvr: string | null;
    leveringsdato: string | null;
    varetekst: string | null;
  };
  data: FirmaFakturaData | null;
};

export default async function FirmaFakturaSide({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await kraevFirma(`/firma/fakturaer/${id}`);
  if (!UUID.test(id)) notFound();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("firma_faktura_hent", { p_id: id });
  if (error) {
    await logDriftFejl({ kilde: "server", hvor: "firma/fakturaer/[id]", fejl: error });
    throw new Error(T.fejl);
  }
  const f = data as Hent | null;
  if (!f || !f.data) notFound();
  const d = f.data;
  // Firmaet er bekræftet ejer (firma_faktura_hent) - så må vi vise, hvor
  // købers adresse kommer fra.
  const auto = f.status === "kladde" && f.type === "faktura" ? await hentKoeberFakturaOplysninger(f.trade_id) : null;
  const navn = dokumentNavn(d);

  return (
    <FirmaSide
      titel={`${navn} ${f.fakturanummer ?? `(${T.kladde.toLowerCase()})`}`}
      tilbage={{ href: "/firma/fakturaer", tekst: `Tilbage til ${T.titel.toLowerCase()}` }}
    >
      <Kort id="handling">
        <FirmaFakturaKnapper
          id={f.id}
          type={f.type}
          status={f.status}
          fakturanummer={f.fakturanummer}
          naesteNummer={f.naeste_fakturanummer}
          koeberEmail={d.koeber.email}
          mangler={d.mangler.map((k) => MANGLER_TEKST[k] ?? k)}
          sendtKl={f.sendt_kl}
          mailFejl={f.mail_fejl}
          mailSendtKl={f.mail_sendt_kl}
          kreditnotaId={f.kreditnota_id}
          visSe={false}
        />
        <a href={`/firma/fakturaer/${f.id}/pdf`} target="_blank" rel="noopener" className={`${E_KNAP_SEKUNDAER} mt-3 w-full sm:w-auto`}>
          {f.status === "sendt" ? "Åbn PDF" : "Se PDF (kladde)"}
        </a>
      </Kort>

      <FirmaFakturaVisning d={d} />

      {f.status === "kladde" && f.type === "faktura" && (
        <Kort id="ret" titel="Ret kladden">
          {auto?.adresse_kilde && <p className={`mb-3 ${E_HJAELP}`}>{ADRESSE_KILDE_TEKST[auto.adresse_kilde]}</p>}
          {auto?.navn_kilde === "mitid" && <p className={`mb-3 ${E_HJAELP}`}>Navnet er købers navn fra MitID.</p>}
          <FirmaFakturaKladdeForm
            id={f.id}
            rettelser={f.rettelser}
            auto={{
              koeber_navn: auto?.navn ?? null,
              koeber_adresse: auto?.adresse ?? null,
              koeber_postnummer: auto?.postnummer ?? null,
              koeber_by: auto?.by ?? null,
              koeber_email: auto?.email ?? null,
              leveringsdato: null,
              varetekst: d.linjer[0]?.tekst ?? null,
            }}
          />
        </Kort>
      )}
    </FirmaSide>
  );
}
