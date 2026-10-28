"use client";

import { useRouter } from "next/navigation";
import ConfirmDialog from "@/components/admin/ConfirmDialog";
import { GIVET_TIL_MAKS, JOURNALNUMMER_MAKS, UDGAVE_NAVN, type SagDokumentationUdgave } from "@/lib/sagDokumentation/regler";

// Knappen "Dokumentation til sælger" / "Dokumentation til politiet" på
// admin-sagssiden. Dialogen spørger, hvem PDF'en gives til (logges), og
// henter derefter PDF'en fra /admin/sager/<id>/dokumentation, som tjekker
// rollen igen, logger udleveringen og sender filen. PDF'en gemmes ikke.

const TEKST: Record<SagDokumentationUdgave, { beskrivelse: string; givetTil: string; standard?: string }> = {
  saelger: {
    beskrivelse:
      "PDF med handlen, beløb, datoer, sporing og vægt, billederne fra auktionen og sagen, chatten, afgørelsen og købers navn og leveringsadresse. Ingen MitID, e-mail eller telefon. Udleveringen logges.",
    givetTil: "Sælger",
    standard: "Sælger",
  },
  politi: {
    beskrivelse:
      "Den fulde udgave med MitID-verificering, e-mail, telefon, handler mellem parterne, andre sager og sagens log. Udleveres kun til politiet, når de beder om det, eller når BidHamr selv anmelder. Udleveringen logges.",
    givetTil: "Politi, kreds eller afdeling",
  },
};

export default function DokumentationKnap({ sagId, udgave }: { sagId: string; udgave: SagDokumentationUdgave }) {
  const router = useRouter();
  const t = TEKST[udgave];

  async function hent(formData: FormData): Promise<{ fejl: string } | { ok: true }> {
    formData.set("udgave", udgave);
    let svar: Response;
    try {
      svar = await fetch(`/admin/sager/${encodeURIComponent(sagId)}/dokumentation`, {
        method: "POST",
        body: formData,
        credentials: "same-origin",
      });
    } catch {
      return { fejl: "Ingen forbindelse. Prøv igen." };
    }
    if (!svar.ok || svar.headers.get("Content-Type") !== "application/pdf") {
      const krop = (await svar.json().catch(() => null)) as { fejl?: unknown } | null;
      return { fejl: typeof krop?.fejl === "string" ? krop.fejl : "PDF'en kunne ikke laves. Prøv igen om lidt." };
    }
    const blob = await svar.blob();
    const navn = /filename="([^"]+)"/.exec(svar.headers.get("Content-Disposition") ?? "")?.[1] ?? "bidhamr-dokumentation.pdf";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = navn;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    router.refresh();
    return { ok: true };
  }

  return (
    <ConfirmDialog
      triggerLabel={UDGAVE_NAVN[udgave]}
      triggerClassName={udgave === "politi" ? "btn btn-fare btn-lille" : "btn btn-sekundaer btn-lille"}
      title={UDGAVE_NAVN[udgave]}
      description={t.beskrivelse}
      confirmLabel="Lav PDF"
      action={hent}
      hiddenFields={{}}
      tekstFelter={[
        {
          name: "givet_til",
          label: "Givet til",
          placeholder: t.givetTil,
          required: true,
          maxLength: GIVET_TIL_MAKS,
          standard: t.standard,
          hjaelp: "Skrives i loggen sammen med dit navn og tidspunktet.",
        },
        {
          name: "journalnummer",
          label: "Journalnummer",
          placeholder: udgave === "politi" ? "Politiets journalnummer" : "Fx politiets journalnummer, hvis sælgeren har anmeldt",
          required: false,
          maxLength: JOURNALNUMMER_MAKS,
        },
      ]}
      kvittering="PDF'en er lavet, og udleveringen er logget"
    />
  );
}
