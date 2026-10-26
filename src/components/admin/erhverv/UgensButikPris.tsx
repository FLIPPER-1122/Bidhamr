"use client";

// Prisen på Ugens butik (Admin -> Erhverv -> Ugens butik). Kun chefen kan
// ændre den (saetUgensButikPrisAction tjekker igen, og databasen logger).
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import BekraeftDialog from "@/components/BekraeftDialog";
import { visKvittering } from "@/components/admin/Kvittering";
import { saetUgensButikPrisAction } from "@/app/actions/adminUgensButik";
import { UGENS_ADMIN as T } from "@/lib/tekster/ugensButik";

export default function UgensButikPris({ eksklKr }: { eksklKr: number }) {
  const router = useRouter();
  const id = useId();
  const [pris, setPris] = useState(String(eksklKr));
  const gyldig = /^\d{3,5}$/.test(pris.trim()) && Number(pris) >= 100 && Number(pris) <= 10000;
  return (
    <BekraeftDialog
      triggerClassName="btn btn-sekundaer btn-lille"
      triggerLabel={T.prisRet}
      title={T.prisTitel}
      description={T.prisForklaring}
      confirmLabel={T.prisGem}
      confirmDisabled={!gyldig || Number(pris) === eksklKr}
      onConfirm={async () => {
        const fd = new FormData();
        fd.set("pris", pris.trim());
        const svar = await saetUgensButikPrisAction(fd);
        if ("fejl" in svar) return { fejl: svar.fejl };
        visKvittering(T.prisGemt);
      }}
      onSuccess={() => router.refresh()}
    >
      <label htmlFor={id} className="block text-sm font-medium text-tekst">
        {T.prisLabel}
      </label>
      <input
        id={id}
        inputMode="numeric"
        value={pris}
        onChange={(e) => setPris(e.target.value)}
        className="mt-1.5 w-full border border-kant-staerk bg-white px-3 py-2.5 text-base text-tekst focus:border-groen focus:outline-2 focus:outline-groen/25 sm:text-sm"
      />
    </BekraeftDialog>
  );
}
