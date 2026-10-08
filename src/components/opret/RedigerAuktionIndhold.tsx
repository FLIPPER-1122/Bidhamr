import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import RedigerAuktionForm from "@/components/RedigerAuktionForm";
import { AuktionLaastTekst } from "@/components/SaelgerAuktionHandlinger";
import { AUKTION_KOLONNER, type AuktionRaekke } from "@/lib/auktionKolonner";

// Indholdet af "Redigér auktion" - fælles for /auktion/[id]/rediger og
// /firma/auktioner/[id]/rediger (firma-dashboardet).
// Sælgeren redigerer sin auktion, så længe der ikke er bud. Efter første bud
// vises formularen ikke - kun en besked om, at auktionen er låst. Databasen
// (rediger_auktion, auctions_beskyt_kolonner) håndhæver det samme og låser
// auktionen under ændringen.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function RedigerAuktionIndhold({ auktionId, brugerId }: { auktionId: string; brugerId: string }) {
  if (!UUID.test(auktionId)) notFound();
  const supabase = await createClient();
  // Kolonneliste (ikke "*"): vinder_id kan ikke læses af brugere.
  const { data: auktion } = await supabase.from("auctions").select(AUKTION_KOLONNER).eq("id", auktionId).maybeSingle<AuktionRaekke>();

  if (!auktion || auktion.skjult || auktion.bruger_id !== brugerId) notFound();

  // Sælgeren kan ikke læse andres bud, men auktion_har_bud svarer ja/nej.
  const { data: harBudData } = await supabase.rpc("auktion_har_bud", { p_auktion_id: auktionId });
  const harBud = auktion.nuværende_bud != null || harBudData === true;
  const erSlut = auktion.status !== "aktiv" || new Date(auktion.slutter_kl) <= new Date();

  if (erSlut) {
    return (
      <p className="rounded-lg border border-kant bg-groen-lys px-4 py-3 text-[17px] text-tekst-daempet">
        Auktionen er ikke aktiv længere og kan ikke ændres.
      </p>
    );
  }
  if (harBud) {
    return (
      <p className="rounded-lg border border-kant bg-groen-lys px-4 py-3 text-[17px] text-tekst-daempet">
        <AuktionLaastTekst />
      </p>
    );
  }
  return (
    <RedigerAuktionForm
      auktionId={auktion.id}
      brugerId={brugerId}
      start={{
        titel: auktion.titel ?? "",
        beskrivelse: auktion.beskrivelse ?? "",
        billeder: auktion.billeder ?? [],
        kategori: auktion.kategori ?? "",
        startpris: Number(auktion.startpris),
        forsendelseMulig: Boolean(auktion.forsendelse_mulig),
        stand: (auktion.stand as string | null | undefined) ?? null,
        producent: (auktion.producent as string | null | undefined) ?? null,
        sikkerhedsoplysninger: (auktion.sikkerhedsoplysninger as string | null | undefined) ?? null,
      }}
      erFirma={auktion.erhverv === true}
    />
  );
}
