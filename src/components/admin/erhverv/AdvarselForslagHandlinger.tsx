"use client";

// Forslag om advarsel til et firma (efter berettigede klager): giv advarslen
// eller afvis forslaget. Databasen tjekker rolle, inhabilitet og status igen.
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import { afvisFirmaAdvarselForslag, givFirmaAdvarselFraForslag } from "@/app/actions/adminErhvervKlager";
import { KLAGE_ADVARSEL_BEGRUNDELSE_MAKS } from "@/lib/erhverv/klager";
import { KLAGE_ADMIN as A } from "@/lib/tekster/erhvervKlager";

const FELT =
  "mt-1 min-h-[80px] w-full rounded-xl border border-kant-staerk bg-white px-3 py-2 text-[15px] focus:border-groen focus:outline-2 focus:outline-groen/25";

export default function AdvarselForslagHandlinger({ forslagId }: { forslagId: string }) {
  const router = useRouter();
  const id = useId();
  const [tilFirma, setTilFirma] = useState("");
  const [note, setNote] = useState("");
  const [afvisGrund, setAfvisGrund] = useState("");
  const [besked, setBesked] = useState<string | null>(null);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2">
        <p className="text-sm font-semibold text-neutral-900">{A.advarselTitel}</p>
        <label htmlFor={`${id}-firma`} className="block text-xs font-medium text-neutral-600">
          {A.advarselBegrundelse}
        </label>
        <textarea
          id={`${id}-firma`}
          value={tilFirma}
          maxLength={KLAGE_ADVARSEL_BEGRUNDELSE_MAKS}
          onChange={(e) => setTilFirma(e.target.value)}
          className={FELT}
        />
        <label htmlFor={`${id}-note`} className="block text-xs font-medium text-neutral-600">
          {A.advarselNote}
        </label>
        <textarea id={`${id}-note`} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} className={FELT} />
        <BekraeftDialog
          triggerLabel={A.knapGivAdvarsel}
          triggerClassName="btn btn-fare"
          title={A.knapGivAdvarsel}
          description={A.bekraeftAdvarsel}
          confirmLabel={A.knapGivAdvarsel}
          confirmDisabled={!tilFirma.trim()}
          onConfirm={async () => {
            const svar = await givFirmaAdvarselFraForslag({ forslagId, begrundelseBruger: tilFirma, internNote: note });
            if ("fejl" in svar) return { fejl: svar.fejl };
            setBesked(svar.lukningForeslaaet ? A.advarselGivetLukning : A.advarselGivet);
          }}
          onSuccess={() => router.refresh()}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-afvis`} className="block text-sm font-semibold text-neutral-900">
          {A.afvisLabel}
        </label>
        <textarea
          id={`${id}-afvis`}
          value={afvisGrund}
          maxLength={2000}
          onChange={(e) => setAfvisGrund(e.target.value)}
          className={FELT}
        />
        <BekraeftDialog
          triggerLabel={A.knapAfvis}
          triggerClassName="btn btn-sekundaer"
          title={A.knapAfvis}
          description={A.bekraeftAfvis}
          confirmLabel={A.knapAfvis}
          confirmDisabled={!afvisGrund.trim()}
          onConfirm={async () => {
            const svar = await afvisFirmaAdvarselForslag({ forslagId, begrundelse: afvisGrund });
            if ("fejl" in svar) return { fejl: svar.fejl };
            setBesked(A.afvist);
          }}
          onSuccess={() => router.refresh()}
        />
      </div>
      {besked && (
        <p role="status" className="text-sm font-medium text-succes-tekst md:col-span-2">
          {besked}
        </p>
      )}
    </div>
  );
}
