"use client"; // Fejlgrænser skal være klientkomponenter

import Link from "next/link";
import { useRapporterFejl } from "@/components/drift/useRapporterFejl";
import { FIRMA_OVERSIGT } from "@/lib/tekster/erhverv";
import { ERHVERV_EMAIL } from "@/lib/erhverv/regler";
import { E_KNAP_PRIMAER } from "@/components/erhverv/stil";

export default function Fejl({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  // Logges til /admin/drift (kun sti, besked og digest).
  useRapporterFejl(error);
  return (
    <main className="flex flex-1 items-center justify-center bg-white px-4 py-16">
      <div role="alert" className="w-full max-w-lg text-center">
        <h1 className="text-[28px] leading-tight">{FIRMA_OVERSIGT.titel}</h1>
        <p className="mt-3 text-[18px] text-tekst">{FIRMA_OVERSIGT.fejlHent}</p>
        <button type="button" onClick={() => retry()} className={`${E_KNAP_PRIMAER} mt-6 w-full sm:w-auto`}>
          Prøv igen
        </button>
        <p className="mt-6 text-[17px] text-tekst-daempet">
          <a href={`mailto:${ERHVERV_EMAIL}`} className="font-semibold text-groen underline">
            {ERHVERV_EMAIL}
          </a>
          {" · "}
          <Link href="/" className="font-semibold text-groen underline">
            Til forsiden
          </Link>
        </p>
      </div>
    </main>
  );
}
