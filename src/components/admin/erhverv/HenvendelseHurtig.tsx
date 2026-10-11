"use client";

// Hurtighandlinger på en erhvervshenvendelse direkte i listen og på
// Oversigt (Filip, 12. okt. 2026): Godkend, Afvis, Notér og - når den er
// godkendt - Opret firmakonto. Samme action som på detaljesiden
// (opdaterErhvervHenvendelse), som tjekker rollen (chef/sælger) igen.
//   - Godkend og "I gang" er ufarlige: ét klik + kvittering.
//   - Afvis er destruktiv: kort bekræftelse.
//   - Notér: lille vindue med standardnoter; noten lægges til de gamle.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import Skabeloner from "@/components/admin/Skabeloner";
import { visKvittering } from "@/components/admin/Kvittering";
import { opdaterErhvervHenvendelse } from "@/app/actions/adminErhverv";
import { ERHVERV_GRAENSER, type HenvendelseStatus } from "@/lib/erhverv/regler";
import { ERHVERV_NOTE } from "@/lib/tekster/adminSkabeloner";

const lille =
  "inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-kant-staerk bg-white px-3 text-[13px] font-medium text-tekst transition-colors hover:bg-admin-bg disabled:opacity-60 lg:min-h-9";

export default function HenvendelseHurtig({
  id,
  firmanavn,
  status,
  noter,
  firmaId,
}: {
  id: string;
  firmanavn: string;
  status: HenvendelseStatus;
  noter: string | null;
  firmaId: string | null;
}) {
  const router = useRouter();
  const feltId = useId();
  const [gemmer, start] = useTransition();
  const [fejl, setFejl] = useState<string | null>(null);
  const [noteAaben, setNoteAaben] = useState(false);
  const [note, setNote] = useState("");

  function saet(nyStatus: HenvendelseStatus, kvittering: string, link?: { href: string; label: string }) {
    setFejl(null);
    start(async () => {
      const svar = await opdaterErhvervHenvendelse({ id, status: nyStatus });
      if ("fejl" in svar) {
        setFejl(svar.fejl);
        return;
      }
      visKvittering(kvittering, link ? { link } : {});
      router.refresh();
    });
  }

  function gemNote() {
    const ren = note.trim();
    if (!ren) return;
    const dato = new Date().toLocaleDateString("da-DK", { day: "numeric", month: "short", timeZone: "Europe/Copenhagen" });
    const samlet = (noter ? `${noter}\n` : "") + `${dato}: ${ren}`;
    if (samlet.length > ERHVERV_GRAENSER.noter) {
      setFejl("Noterne er for lange. Ret dem på henvendelsen.");
      return;
    }
    setFejl(null);
    start(async () => {
      const svar = await opdaterErhvervHenvendelse({ id, noter: samlet, status: status === "ny" ? "i_gang" : null });
      if ("fejl" in svar) {
        setFejl(svar.fejl);
        return;
      }
      setNoteAaben(false);
      setNote("");
      visKvittering(status === "ny" ? "Noten er gemt, og henvendelsen står som i gang" : "Noten er gemt");
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {status !== "godkendt" && status !== "afvist" && (
          <button
            type="button"
            disabled={gemmer}
            onClick={() =>
              saet("godkendt", `${firmanavn} er godkendt`, { href: `/admin/erhverv/henvendelser/${id}#opret`, label: "Opret firmakonto" })
            }
            className="btn btn-primaer btn-lille"
          >
            {gemmer && <span className="btn-spinner" aria-hidden="true" />}
            Godkend
          </button>
        )}
        {status === "godkendt" && !firmaId && (
          <Link href={`/admin/erhverv/henvendelser/${id}#opret`} className="btn btn-primaer btn-lille">
            Opret firmakonto
          </Link>
        )}
        {firmaId && (
          <Link href={`/admin/erhverv/firmaer/${firmaId}`} className={lille}>
            Se firma
          </Link>
        )}
        <button type="button" onClick={() => setNoteAaben((v) => !v)} aria-expanded={noteAaben} className={lille}>
          Notér
        </button>
        {status === "ny" && (
          <button type="button" disabled={gemmer} onClick={() => saet("i_gang", "Henvendelsen står som i gang")} className={lille}>
            Markér i gang
          </button>
        )}
        {status !== "afvist" && !firmaId && (
          <BekraeftDialog
            triggerLabel="Afvis"
            triggerClassName="inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-fejl-kant bg-white px-3 text-[13px] font-medium text-fejl-tekst hover:bg-fejl-bg lg:min-h-9"
            title={`Afvis ${firmanavn}?`}
            description="Henvendelsen markeres som afvist. Firmaet får ikke automatisk besked – skriv til dem, hvis de skal have et svar. Du kan ændre status igen på henvendelsen."
            confirmLabel="Afvis"
            onConfirm={async () => {
              const svar = await opdaterErhvervHenvendelse({ id, status: "afvist" });
              if ("fejl" in svar) return { fejl: svar.fejl };
              visKvittering(`${firmanavn} er afvist`);
              router.refresh();
            }}
          />
        )}
        <Link href={`/admin/erhverv/henvendelser/${id}`} className="inline-flex min-h-10 items-center px-1 text-[13px] font-semibold text-groen hover:underline lg:min-h-9">
          Læs alt →
        </Link>
      </div>
      {noteAaben && (
        <div className="rounded-lg border border-admin-kant bg-admin-bg p-3">
          <label htmlFor={feltId} className="block text-sm font-medium text-tekst">
            Ny note (kun staff)
          </label>
          <Skabeloner skabeloner={ERHVERV_NOTE} onVaelg={setNote} feltId={feltId} />
          <textarea
            id={feltId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={1000}
            className="mt-1.5 w-full rounded-lg border border-kant-staerk bg-white px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-groen sm:text-sm"
          />
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={gemNote} disabled={gemmer || !note.trim()} className="btn btn-primaer btn-lille">
              Gem note
            </button>
            <button type="button" onClick={() => setNoteAaben(false)} className={lille}>
              Annullér
            </button>
          </div>
        </div>
      )}
      {fejl && (
        <p role="alert" className="text-sm font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}
    </div>
  );
}
