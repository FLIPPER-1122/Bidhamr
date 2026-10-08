"use client";

// Admin -> Erhverv -> Firma: abonnementet i Stripe. Kun chef kan opsige
// (cancel_at_period_end - stopper ved periodens slut, ingen refusion) eller
// fortryde opsigelsen. Firmaet kan ikke selv opsige.
import { useRouter } from "next/navigation";
import { useState } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import { fortrydFirmaOpsigelse, opsigFirmaAbonnement } from "@/app/actions/adminErhverv";
import { ADMIN_ERHVERV_BETALING as AB } from "@/lib/tekster/erhverv";

export default function FirmaAbonnementStripe({
  firmaId,
  erChef,
  harAbonnement,
  opsiges,
  opsagt,
}: {
  firmaId: string;
  erChef: boolean;
  harAbonnement: boolean;
  // Dansk dato, når abonnementet er opsagt og stopper; ellers null.
  opsiges: string | null;
  opsagt: boolean;
}) {
  const router = useRouter();
  const [besked, setBesked] = useState<string | null>(null);

  if (!erChef) return <p className="text-sm text-tekst-daempet">{AB.kunChef}</p>;
  if (opsagt) return null;

  return (
    <div className="space-y-3">
      {opsiges ? (
        <BekraeftDialog
          triggerLabel={AB.knapFortryd}
          title={AB.knapFortryd}
          confirmLabel={AB.knapFortryd}
          onConfirm={async () => {
            setBesked(null);
            const svar = await fortrydFirmaOpsigelse(firmaId);
            if ("fejl" in svar) return { fejl: svar.fejl };
            setBesked(svar.besked);
            router.refresh();
          }}
        />
      ) : (
        <BekraeftDialog
          triggerLabel={AB.knapOpsig}
          title={AB.bekraeftOpsigTitel}
          description={harAbonnement ? AB.bekraeftOpsig : AB.ingenAbonnement}
          confirmLabel={AB.knapOpsig}
          onConfirm={async () => {
            setBesked(null);
            const svar = await opsigFirmaAbonnement(firmaId);
            if ("fejl" in svar) return { fejl: svar.fejl };
            setBesked(svar.besked);
            router.refresh();
          }}
        />
      )}
      {besked && (
        <p role="status" className="rounded-lg border border-succes-kant bg-succes-bg px-4 py-3 text-sm font-medium text-succes-tekst">
          {besked}
        </p>
      )}
    </div>
  );
}
