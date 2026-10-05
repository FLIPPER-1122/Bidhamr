"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import BekraeftDialog from "@/components/BekraeftDialog";
import { annullerAuktion } from "@/app/actions/auktion";

// Vises for sælgeren på en igangværende auktion. Redigering og annullering
// er kun muligt, indtil det første bud kommer – derefter er auktionen låst
// (også i databasen).
export default function SaelgerAuktionHandlinger({
  auktionId,
  harBud,
}: {
  auktionId: string;
  harBud: boolean;
}) {
  const router = useRouter();

  if (harBud) {
    return (
      <p className="mb-4 rounded-lg border border-kant bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
        Der er budt på din auktion, så den kan ikke længere ændres eller annulleres.
      </p>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-kant bg-white p-4">
      <p className="text-sm text-tekst-daempet">
        Du kan ændre eller annullere auktionen, indtil der kommer det første bud.
        Varigheden kan ikke ændres.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link href={`/auktion/${auktionId}/rediger`} className="btn btn-sekundaer btn-lille">
          Redigér auktion
        </Link>
        <BekraeftDialog
          triggerLabel="Annullér auktion"
          triggerClassName="btn btn-tekst btn-lille"
          title="Annullér auktionen?"
          description="Auktionen fjernes fra BidHamr, og ingen kan byde på den. Det kan ikke fortrydes."
          confirmLabel="Annullér auktion"
          cancelLabel="Behold auktionen"
          onConfirm={async () => {
            const svar = await annullerAuktion(auktionId);
            if ("fejl" in svar) return { fejl: svar.fejl };
          }}
          onSuccess={() => router.refresh()}
        />
      </div>
    </div>
  );
}
