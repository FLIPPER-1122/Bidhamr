"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Ikon from "@/components/Ikon";
import { foelgSaelger, stopFoelgSaelger } from "@/app/actions/foelg";

// "Følg" / "Følger" på sælgerprofilen og auktionssiden. Uden login er det et
// link til login, der kommer tilbage til siden bagefter.
export default function FoelgKnap({
  saelgerId,
  navn,
  foelger,
  loginHref,
  lille = false,
}: {
  saelgerId: string;
  navn: string;
  foelger: boolean;
  // Sat = brugeren er ikke logget ind.
  loginHref?: string;
  lille?: boolean;
}) {
  const router = useRouter();
  const [aktiv, setAktiv] = useState(foelger);
  const [fejl, setFejl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const stoerrelse = lille ? "btn-lille" : "";

  if (loginHref) {
    return (
      <Link href={loginHref} className={`btn btn-sekundaer ${stoerrelse}`}>
        <Ikon navn="plus" className="h-4 w-4" />
        Følg
      </Link>
    );
  }

  function skift() {
    setFejl(null);
    const ny = !aktiv;
    // Vises med det samme; rulles tilbage, hvis det fejler.
    setAktiv(ny);
    startTransition(async () => {
      const res = ny ? await foelgSaelger(saelgerId) : await stopFoelgSaelger(saelgerId);
      if ("fejl" in res) {
        setAktiv(!ny);
        setFejl(res.fejl);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={skift}
        disabled={pending}
        aria-pressed={aktiv}
        aria-busy={pending || undefined}
        aria-label={aktiv ? `Du følger ${navn}. Tryk for at stoppe med at følge` : `Følg ${navn}`}
        title={aktiv ? "Tryk for at stoppe med at følge" : undefined}
        className={`btn ${stoerrelse} ${
          aktiv ? "border border-groen bg-groen-lys text-groen-mork hover:bg-white" : "btn-sekundaer"
        }`}
      >
        {pending ? (
          <span className="btn-spinner" aria-hidden="true" />
        ) : (
          !aktiv && <Ikon navn="plus" className="h-4 w-4" />
        )}
        {aktiv ? "Følger" : "Følg"}
      </button>
      {fejl && (
        <p role="alert" className="text-[13px] font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}
    </div>
  );
}
