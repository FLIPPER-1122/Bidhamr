"use client";

// Rød boks på sagen i admin, når staff skal se på noget (sager.kraever_
// opmaerksomhed, 20261102350000) - fx at regningen for returfragt til
// sælgeren ikke kunne oprettes, eller at en betalt regning skal håndteres
// efter en genåbning. Ét klik lukker markeringen, når det er håndteret.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { lukSagMarkering } from "@/app/actions/adminSager";

export default function SagMarkering({ sagId, tekst, kanLukke }: { sagId: string; tekst: string | null; kanLukke: boolean }) {
  const router = useRouter();
  const [sender, start] = useTransition();
  const [fejl, setFejl] = useState<string | null>(null);

  function luk() {
    setFejl(null);
    start(async () => {
      const fd = new FormData();
      fd.set("sagId", sagId);
      const r = await lukSagMarkering(fd);
      if ("fejl" in r) setFejl(r.fejl);
      else router.refresh();
    });
  }

  return (
    <div role="alert" className="mt-3 rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
      <p className="font-semibold">Sagen kræver opmærksomhed</p>
      {tekst && <p className="mt-1 whitespace-pre-wrap break-words">{tekst}</p>}
      {kanLukke && (
        <button type="button" onClick={luk} disabled={sender} className="btn btn-sekundaer mt-2">
          {sender ? "Lukker…" : "Luk markeringen – det er håndteret"}
        </button>
      )}
      {fejl && <p className="mt-1 font-medium">{fejl}</p>}
    </div>
  );
}
