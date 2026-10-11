"use client";

// Status og staff-note på én beta-fejl (Admin -> Beta-fejl).
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { opdaterBetaFejl } from "@/app/actions/adminBetaFejl";
import { BETA_FEJL_MAKS_NOTE, BETA_FEJL_STATUS, STATUS_NAVN, type BetaFejlStatus } from "@/lib/betaFejl";

export default function BetaFejlRedigering({
  id,
  status: startStatus,
  staffNote,
  opdateretKl,
}: {
  id: string;
  status: BetaFejlStatus;
  staffNote: string | null;
  opdateretKl: string | null;
}) {
  const feltId = useId();
  const router = useRouter();
  const [status, setStatus] = useState<BetaFejlStatus>(startStatus);
  const [note, setNote] = useState(staffNote ?? "");
  const [besked, setBesked] = useState<{ ok: boolean; tekst: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const aendret = status !== startStatus || note.trim() !== (staffNote ?? "").trim();

  function gem() {
    setBesked(null);
    startTransition(async () => {
      try {
        const svar = await opdaterBetaFejl({ id, status, staffNote: note });
        if ("fejl" in svar) {
          setBesked({ ok: false, tekst: svar.fejl });
          return;
        }
        setBesked({ ok: true, tekst: "Gemt." });
        router.refresh();
      } catch {
        setBesked({ ok: false, tekst: "Kunne ikke gemme. Tjek forbindelsen, og prøv igen." });
      }
    });
  }

  return (
    <div className="mt-4 grid gap-3 border-t border-neutral-100 pt-4 sm:grid-cols-[180px_1fr]">
      <div>
        <label htmlFor={`${feltId}-status`} className="mb-1 block text-xs font-medium text-neutral-600">
          Status
        </label>
        <select
          id={`${feltId}-status`}
          value={status}
          onChange={(e) => setStatus(e.target.value as BetaFejlStatus)}
          disabled={pending}
          className="h-11 w-full rounded-xl border border-kant-staerk bg-white px-3 text-sm focus:border-groen focus:outline-2 focus:outline-groen/25"
        >
          {BETA_FEJL_STATUS.map((s) => (
            <option key={s} value={s}>
              {STATUS_NAVN[s]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${feltId}-note`} className="mb-1 block text-xs font-medium text-neutral-600">
          Staff-note <span className="font-normal text-neutral-500">(kun synlig for staff)</span>
        </label>
        <textarea
          id={`${feltId}-note`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={BETA_FEJL_MAKS_NOTE}
          rows={2}
          disabled={pending}
          className="w-full rounded-xl border border-kant-staerk bg-white px-3 py-2 text-sm focus:border-groen focus:outline-2 focus:outline-groen/25"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button
          type="button"
          onClick={gem}
          disabled={pending || !aendret}
          aria-busy={pending || undefined}
          className="btn btn-primaer btn-lille"
        >
          {pending && <span className="btn-spinner" aria-hidden="true" />}
          Gem
        </button>
        {besked && (
          <span role={besked.ok ? "status" : "alert"} className={`text-sm ${besked.ok ? "text-succes-tekst" : "text-fejl-tekst"}`}>
            {besked.tekst}
          </span>
        )}
        {opdateretKl && !besked && <span className="text-xs text-neutral-500">Senest ændret {opdateretKl}</span>}
      </div>
    </div>
  );
}
