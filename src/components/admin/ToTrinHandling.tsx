"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { visKvittering } from "@/components/admin/Kvittering";

// Chefens "Nulstil to-trins-login" og "Åbn tilmelding (24 t)" på Admin →
// Medarbejdere. Kræver en kode fra chefens egen app, der højst er 15
// minutter gammel: feltet vises, når serveren beder om det (eller allerede
// ved visningen, hvis den seneste kode er for gammel).
type Props = {
  userId: string;
  navn: string;
  handling: (formData: FormData) => Promise<{ ok: true } | { fejl: string; kodeKraeves?: true }>;
  label: string;
  kvittering: string;
  // Spørg først (nulstilling).
  bekraeft?: string;
  kraeverKode: boolean;
  farlig?: boolean;
};

export default function ToTrinHandling({ userId, navn, handling, label, kvittering, bekraeft, kraeverKode, farlig }: Props) {
  const router = useRouter();
  const id = useId();
  const [visKode, setVisKode] = useState(kraeverKode);
  const [kode, setKode] = useState("");
  const [fejl, setFejl] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function send(e: FormEvent) {
    e.preventDefault();
    if (bekraeft && !window.confirm(bekraeft.replace("{navn}", navn))) return;
    setFejl(null);
    const fd = new FormData();
    fd.set("userId", userId);
    if (visKode) fd.set("kode", kode);
    start(async () => {
      let r: Awaited<ReturnType<typeof handling>>;
      try {
        r = await handling(fd);
      } catch {
        setFejl("Der er ingen forbindelse. Prøv igen.");
        return;
      }
      if ("fejl" in r) {
        if (r.kodeKraeves) setVisKode(true);
        setFejl(r.fejl);
        return;
      }
      setKode("");
      setVisKode(false);
      visKvittering(kvittering);
      router.refresh();
    });
  }

  return (
    <form onSubmit={send} className="min-w-0 space-y-1.5">
      {visKode && (
        <div>
          <label htmlFor={`${id}-kode`} className="block text-xs font-medium text-tekst-daempet">
            Kode fra din app
          </label>
          <input
            id={`${id}-kode`}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]*"
            maxLength={7}
            value={kode}
            onChange={(e) => setKode(e.target.value)}
            className="mt-1 h-9 w-28 rounded-lg border border-kant-staerk bg-white px-2 text-sm tracking-widest"
          />
        </div>
      )}
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className={`rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-60 ${
          farlig ? "bg-red-100 text-red-800 hover:bg-red-200" : "bg-amber-100 text-amber-900 hover:bg-amber-200"
        }`}
      >
        {pending && <span className="btn-spinner" aria-hidden="true" />}
        {label}
      </button>
      {fejl && (
        <p role="alert" className="max-w-[260px] text-xs font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}
    </form>
  );
}
