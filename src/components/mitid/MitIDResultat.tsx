"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { MITID, MITID_RESULTATER, erMitIdSucces, type MitIdResultat } from "@/lib/tekster/mitid";

// Besked efter MitID: callbacken sender brugeren tilbage med ?mitid=<resultat>.
// Kun kendte værdier vises (aldrig tekst fra URL'en). Parameteren fjernes fra
// adressen, så beskeden ikke kommer igen ved genindlæsning.
export default function MitIDResultat() {
  const sp = useSearchParams();
  const sti = usePathname();
  const router = useRouter();
  const raa = sp.get("mitid");
  // Callbacken er en fuld sideindlæsning, så værdien læses ved første render.
  const [resultat, setResultat] = useState<MitIdResultat | null>(() =>
    raa && (MITID_RESULTATER as string[]).includes(raa) ? (raa as MitIdResultat) : null,
  );

  useEffect(() => {
    if (!raa) return;
    const ny = new URLSearchParams(sp.toString());
    ny.delete("mitid");
    const q = ny.toString();
    router.replace(q ? `${sti}?${q}` : sti, { scroll: false });
  }, [raa, sp, sti, router]);

  if (!resultat) return null;
  const succes = erMitIdSucces(resultat);
  return (
    <div className="px-4 pt-4 sm:px-6">
      <div
        role={succes ? "status" : "alert"}
        className={`mx-auto flex max-w-3xl items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
          succes ? "border-succes-kant bg-succes-bg text-succes-tekst" : "border-advarsel-kant bg-advarsel-bg text-advarsel-tekst"
        }`}
      >
        <p className="flex-1">{MITID.resultat[resultat]}</p>
        <button
          type="button"
          onClick={() => setResultat(null)}
          className="min-h-11 shrink-0 rounded-md px-2 font-medium underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Luk
        </button>
      </div>
    </div>
  );
}
