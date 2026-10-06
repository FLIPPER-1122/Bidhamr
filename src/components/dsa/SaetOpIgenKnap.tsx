"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saetVarenOpIgen } from "@/app/actions/auktion";

// "Sæt varen op igen" med ét klik. En annulleret auktion genåbnes aldrig -
// der oprettes en ny auktion med samme indhold, startpris og varighed.
export default function SaetOpIgenKnap({ auktionId }: { auktionId: string }) {
  const router = useRouter();
  const [fejl, setFejl] = useState<string | null>(null);
  const [sender, start] = useTransition();

  function klik() {
    setFejl(null);
    start(async () => {
      const r = await saetVarenOpIgen(auktionId);
      if ("fejl" in r) {
        setFejl(r.fejl);
        return;
      }
      router.push(`/auktion/${r.auktionId}`);
    });
  }

  return (
    <div className="mt-3">
      <button type="button" onClick={klik} disabled={sender} aria-busy={sender || undefined} className="btn btn-primaer">
        {sender && <span className="btn-spinner" aria-hidden="true" />}
        Sæt varen op igen
      </button>
      {fejl && (
        <p role="alert" className="mt-3 rounded-xl border border-fejl-kant bg-fejl-bg p-4 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
    </div>
  );
}
