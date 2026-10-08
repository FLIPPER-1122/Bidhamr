import { kraevFirma } from "@/lib/erhverv/firmaData";
import { foerLancering } from "@/lib/lancering";
import OpretAuktionIndhold from "@/components/opret/OpretAuktionIndhold";
import { FirmaSide, LukketBoks } from "@/components/firma/dele";
import { FIRMA_DASHBOARD as D } from "@/lib/tekster/erhverv";

// Opret auktion inde i firma-dashboardet - samme formular, tjek og
// validering som /opret-auktion (OpretAuktionIndhold/OpretAuktionForm).
// Før lancering kan der ikke sælges: så vises kun en forklaring.

export const metadata = { title: D.opret.titel };

export default async function FirmaOpretAuktion({ searchParams }: { searchParams: Promise<{ stripe?: string }> }) {
  const { bruger } = await kraevFirma("/firma/auktioner/ny");
  const { stripe } = await searchParams;
  const lukket = foerLancering();

  return (
    <FirmaSide titel={D.opret.titel} tilbage={{ href: "/firma/auktioner", tekst: D.tilbage(D.auktioner.titel) }}>
      {lukket ? <LukketBoks tekst={D.opret.lukket} /> : <OpretAuktionIndhold brugerId={bruger.id} stripe={stripe} />}
    </FirmaSide>
  );
}
