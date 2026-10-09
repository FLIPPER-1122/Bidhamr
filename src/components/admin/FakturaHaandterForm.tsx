"use client";

import { useState, useTransition } from "react";

// "Markér som håndteret i Dinero" med en kort note (Admin -> Fakturaer).
export default function FakturaHaandterForm({
  id,
  action,
}: {
  id: string;
  action: (formData: FormData) => Promise<{ ok: true } | { fejl: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const [fejl, setFejl] = useState<string | null>(null);

  return (
    <form
      action={(fd) =>
        startTransition(async () => {
          setFejl(null);
          const res = await action(fd);
          if ("fejl" in res) setFejl(res.fejl);
        })
      }
      className="flex flex-col gap-2"
    >
      <input type="hidden" name="id" value={id} />
      <label className="text-xs font-medium text-tekst-daempet" htmlFor={`note-${id}`}>
        Hvad har du gjort i Dinero?
      </label>
      <input
        id={`note-${id}`}
        name="note"
        required
        maxLength={1000}
        placeholder="Fx: faktura nr. 123 lavet manuelt"
        className="min-h-11 rounded-lg border border-kant px-3 text-sm"
      />
      <button type="submit" disabled={pending} aria-busy={pending} className="btn btn-sekundaer btn-lille disabled:opacity-50">
        Markér som håndteret i Dinero
      </button>
      {fejl && (
        <p role="alert" className="text-xs text-fejl-tekst">
          {fejl}
        </p>
      )}
    </form>
  );
}
