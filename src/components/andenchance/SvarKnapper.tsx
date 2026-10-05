"use client";

import { useRouter } from "next/navigation";
import BekraeftDialog from "@/components/BekraeftDialog";
import { svarAndenchance } from "@/app/actions/andenchance";

export default function SvarKnapper({ tilbudId, total }: { tilbudId: string; total: string }) {
  const router = useRouter();

  return (
    <div className="mt-5 flex flex-col gap-3 sm:flex-row">
      <BekraeftDialog
        triggerLabel="Ja, køb varen"
        triggerClassName="btn btn-primaer w-full sm:w-auto"
        title="Køb varen?"
        description={`Du forpligter dig til at betale ${total} inden for 48 timer.`}
        confirmLabel="Ja, køb varen"
        onConfirm={async () => {
          const svar = await svarAndenchance(tilbudId, true);
          if ("fejl" in svar) return { fejl: svar.fejl };
          router.push(svar.tradeId ? `/mine-handler/${svar.tradeId}` : "/mine-handler");
        }}
      />
      <BekraeftDialog
        triggerLabel="Nej tak"
        triggerClassName="btn btn-sekundaer w-full sm:w-auto"
        title="Sig nej tak?"
        description="Tilbuddet går videre, og du kan ikke fortryde."
        confirmLabel="Nej tak"
        onConfirm={async () => {
          const svar = await svarAndenchance(tilbudId, false);
          if ("fejl" in svar) return { fejl: svar.fejl };
        }}
        onSuccess={() => router.refresh()}
      />
    </div>
  );
}
