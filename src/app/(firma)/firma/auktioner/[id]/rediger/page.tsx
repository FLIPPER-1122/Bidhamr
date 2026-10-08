import { kraevFirma } from "@/lib/erhverv/firmaData";
import { foerLancering } from "@/lib/lancering";
import RedigerAuktionIndhold from "@/components/opret/RedigerAuktionIndhold";
import { FirmaSide, LukketBoks } from "@/components/firma/dele";
import { FIRMA_DASHBOARD as D } from "@/lib/tekster/erhverv";

// Redigér auktion inde i firma-dashboardet - samme tjek og formular som
// /auktion/[id]/rediger (låst efter første bud).

export const metadata = { title: D.rediger.titel };

export default async function FirmaRedigerAuktion({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { bruger } = await kraevFirma(`/firma/auktioner/${id}/rediger`);
  const lukket = foerLancering();

  return (
    <FirmaSide titel={D.rediger.titel} tilbage={{ href: "/firma/auktioner", tekst: D.tilbage(D.auktioner.titel) }}>
      {lukket ? <LukketBoks tekst={D.rediger.lukket} /> : <RedigerAuktionIndhold auktionId={id} brugerId={bruger.id} />}
    </FirmaSide>
  );
}
