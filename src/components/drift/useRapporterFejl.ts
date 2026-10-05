"use client";

import { useEffect } from "react";
import { rapporterKlientFejl } from "@/app/actions/drift";

// Allerede rapporteret i denne fane (digest eller besked), så "Prøv igen"
// og genrenderinger ikke sender samme fejl igen og igen.
const rapporteret = new Set<string>();

// Til error boundaries (error.tsx/global-error.tsx): sender fejlen til
// drift_fejl, så den kan ses på /admin/drift. Kun stien (ingen
// query-streng), beskeden og digest sendes. Kaster aldrig.
export function useRapporterFejl(error: (Error & { digest?: string }) | null | undefined) {
  useEffect(() => {
    if (!error) return;
    const noegle = error.digest ?? error.message ?? "ukendt";
    if (rapporteret.has(noegle)) return;
    rapporteret.add(noegle);
    rapporterKlientFejl({
      sti: typeof window !== "undefined" ? window.location.pathname : null,
      besked: error.message,
      digest: error.digest,
    }).catch(() => {
      // Serveren svarer ikke - intet at gøre.
    });
  }, [error]);
}
