"use client";

import { useState, useTransition } from "react";
import { visMitIdOplysninger, type MitIdOplysninger } from "@/app/actions/adminMitid";

// Juridisk navn og fødselsdato fra MitID (kun internt). Hentes og logges
// først, når medarbejderen trykker "Vis" (visMitIdOplysninger).
export default function MitIdVisOplysninger({ brugerId }: { brugerId: string }) {
  const [data, setData] = useState<MitIdOplysninger | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [venter, startTransition] = useTransition();

  function vis() {
    setFejl(null);
    startTransition(async () => {
      const svar = await visMitIdOplysninger(brugerId);
      if ("fejl" in svar) setFejl(svar.fejl);
      else setData(svar.data);
    });
  }

  if (!data) {
    return (
      <div className="sm:col-span-2">
        <dt className="text-neutral-500">Juridisk navn og fødselsdato (kun internt)</dt>
        <dd className="mt-1">
          <button
            type="button"
            onClick={vis}
            disabled={venter}
            className="inline-flex items-center rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-semibold text-neutral-800 hover:bg-neutral-200 transition-colors disabled:opacity-60"
          >
            {venter ? "Henter …" : "Vis"}
          </button>
          <p className="mt-1 text-xs text-neutral-500">Opslaget logges.</p>
          {fejl && (
            <p role="alert" className="mt-1 text-sm text-red-700">
              {fejl}
            </p>
          )}
        </dd>
      </div>
    );
  }

  return (
    <>
      <div>
        <dt className="text-neutral-500">Juridisk navn (kun internt)</dt>
        <dd className="text-neutral-900">{data.juridiskNavn ?? "–"}</dd>
      </div>
      <div>
        <dt className="text-neutral-500">Fødselsdato (kun internt)</dt>
        <dd className="text-neutral-900">
          {data.foedselsdato ? new Date(data.foedselsdato).toLocaleDateString("da-DK") : "–"}
        </dd>
      </div>
    </>
  );
}
