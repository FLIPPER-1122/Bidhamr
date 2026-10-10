"use client";

// Køberen trækker sin åbne klage tilbage (fx fordi firmaet har løst det).
import { useRouter } from "next/navigation";
import BekraeftDialog from "@/components/BekraeftDialog";
import { traekErhvervKlageTilbage } from "@/app/actions/erhvervKlager";
import { KLAGE_KOEBER as T } from "@/lib/tekster/erhvervKlager";

export default function TraekKlageTilbage({ klageId }: { klageId: string }) {
  const router = useRouter();
  return (
    <BekraeftDialog
      triggerLabel={T.knapTraekTilbage}
      triggerClassName="btn btn-sekundaer"
      title={T.traekTitel}
      description={T.traekTekst}
      confirmLabel={T.traekKnap}
      onConfirm={async () => {
        const svar = await traekErhvervKlageTilbage(klageId);
        if ("fejl" in svar) return { fejl: svar.fejl };
      }}
      onSuccess={() => router.refresh()}
    />
  );
}
