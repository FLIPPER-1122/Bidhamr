"use client";

// "Tag sagen" på en klage over et firma direkte i listen: ét klik + kvittering
// (tagErhvervKlage - status 'under_behandling', du står som behandler).
// Ufarlig: ingen penge og ingen besked til køber eller firma.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { tagErhvervKlage } from "@/app/actions/adminErhvervKlager";
import { visKvittering } from "@/components/admin/Kvittering";

export default function TagKlageKnap({ id, nummer }: { id: string; nummer: number }) {
  const router = useRouter();
  const [gemmer, start] = useTransition();
  const [fejl, setFejl] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        disabled={gemmer}
        aria-busy={gemmer}
        onClick={() =>
          start(async () => {
            setFejl(null);
            const svar = await tagErhvervKlage(id);
            if ("fejl" in svar) {
              setFejl(svar.fejl);
              return;
            }
            visKvittering(`Du har taget klage #${nummer}`, { link: { href: `/admin/erhverv/klager/${id}`, label: "Åbn klagen" } });
            router.refresh();
          })
        }
        className="btn btn-primaer btn-lille"
      >
        {gemmer && <span className="btn-spinner" aria-hidden="true" />}
        Tag sagen
      </button>
      {fejl && (
        <span role="alert" className="mt-1 text-xs font-medium text-fejl-tekst">
          {fejl}
        </span>
      )}
    </span>
  );
}
