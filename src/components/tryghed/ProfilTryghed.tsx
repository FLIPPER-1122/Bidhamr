"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import BekraeftDialog from "@/components/BekraeftDialog";
import RapporterDialog from "@/components/tryghed/RapporterDialog";
import { blokerBruger, fjernBlokeringAfBruger } from "@/app/actions/tryghed";

// "Blokér" / "Fjern blokering" og "Rapportér bruger" på en andens profil.
export default function ProfilTryghed({
  brugerId,
  navn,
  erBlokeret,
}: {
  brugerId: string;
  navn: string;
  erBlokeret: boolean;
}) {
  const router = useRouter();
  const [blokeret, setBlokeret] = useState(erBlokeret);
  const [fejl, setFejl] = useState<string | null>(null);

  async function fjern() {
    setFejl(null);
    const res = await fjernBlokeringAfBruger(brugerId);
    if ("fejl" in res) {
      setFejl(res.fejl);
      return;
    }
    setBlokeret(false);
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {blokeret ? (
        <>
          <span className="text-sm text-tekst-daempet">Du har blokeret {navn}.</span>
          <button type="button" onClick={fjern} className="btn btn-tekst text-sm">
            Fjern blokering
          </button>
        </>
      ) : (
        <BekraeftDialog
          triggerLabel="Blokér"
          triggerClassName="btn btn-tekst text-sm"
          title={`Blokér ${navn}?`}
          description={`${navn} kan ikke byde på dine auktioner, skrive til dig eller stille dig spørgsmål. Handler, I allerede er i gang med, kan stadig gennemføres. Du kan altid fjerne blokeringen under Min konto.`}
          confirmLabel="Ja, blokér"
          onConfirm={async () => {
            const res = await blokerBruger(brugerId);
            return "fejl" in res ? { fejl: res.fejl } : undefined;
          }}
          onSuccess={() => {
            setBlokeret(true);
            router.refresh();
          }}
        />
      )}
      <RapporterDialog
        brugerId={brugerId}
        titel={`Rapportér ${navn}`}
        triggerLabel="Rapportér bruger"
        triggerClassName="btn btn-tekst text-sm"
      />
      {fejl && (
        <p role="alert" className="w-full text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
    </div>
  );
}
