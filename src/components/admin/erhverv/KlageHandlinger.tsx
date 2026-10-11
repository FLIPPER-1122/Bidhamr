"use client";

// Staffs handlinger på en klage: tag den, skriv intern note, log kontakt med
// firmaet og afgør (berettiget / ikke berettiget med begrundelse til køber og
// firma). Databasen tjekker rolle, inhabilitet og status igen.
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import { afgoerErhvervKlage, gemErhvervKlageNote, tagErhvervKlage } from "@/app/actions/adminErhvervKlager";
import { KLAGE_BEGRUNDELSE_MAKS, KLAGE_NOTE_MAKS, type KlageKanal, type KlageStatus } from "@/lib/erhverv/klager";
import { KLAGE_ADMIN as A, KLAGE_KANAL_NAVN } from "@/lib/tekster/erhvervKlager";

const FELT =
  "mt-1 min-h-[100px] w-full rounded-xl border border-kant-staerk bg-white px-3 py-2 text-[15px] focus:border-groen focus:outline-2 focus:outline-groen/25";

export default function KlageHandlinger({ id, status }: { id: string; status: KlageStatus }) {
  const router = useRouter();
  const uid = useId();
  const [gemmer, start] = useTransition();
  const [noteType, setNoteType] = useState<"note" | "kontakt_firma">("note");
  const [kanal, setKanal] = useState<KlageKanal>("telefon");
  const [noteTekst, setNoteTekst] = useState("");
  const [begrundelse, setBegrundelse] = useState("");
  const [besked, setBesked] = useState<{ tekst: string; fejl: boolean } | null>(null);
  const afsluttet = status === "afsluttet";

  function gemNote() {
    setBesked(null);
    start(async () => {
      const svar = await gemErhvervKlageNote({ id, type: noteType, kanal, tekst: noteTekst });
      if ("fejl" in svar) {
        setBesked({ tekst: svar.fejl, fejl: true });
        return;
      }
      setNoteTekst("");
      setBesked({ tekst: A.noteGemt, fejl: false });
      router.refresh();
    });
  }

  async function afgoer(afgoerelse: "berettiget" | "ikke_berettiget") {
    const svar = await afgoerErhvervKlage({ id, afgoerelse, begrundelse });
    if ("fejl" in svar) return { fejl: svar.fejl };
    if (svar.forslagNy) setBesked({ tekst: A.giverForslag, fejl: false });
  }

  return (
    <div className="space-y-6">
      {status === "aaben" && (
        <button
          type="button"
          disabled={gemmer}
          onClick={() =>
            start(async () => {
              const svar = await tagErhvervKlage(id);
              if ("fejl" in svar) setBesked({ tekst: svar.fejl, fejl: true });
              else router.refresh();
            })
          }
          className="btn btn-sekundaer"
        >
          {A.knapTag}
        </button>
      )}

      <div className="space-y-2">
        <div role="radiogroup" aria-label={A.noter} className="flex flex-wrap gap-2">
          {(["note", "kontakt_firma"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={noteType === t}
              onClick={() => setNoteType(t)}
              className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium ${
                noteType === t ? "border-groen bg-groen text-white" : "border-neutral-300 bg-white text-neutral-700"
              }`}
            >
              {A.noteType[t]}
            </button>
          ))}
        </div>
        {noteType === "kontakt_firma" && (
          <div>
            <label htmlFor={`${uid}-kanal`} className="block text-xs font-medium text-neutral-600">
              {A.kanalLabel}
            </label>
            <select
              id={`${uid}-kanal`}
              value={kanal}
              onChange={(e) => setKanal(e.target.value as KlageKanal)}
              className="mt-1 min-h-11 rounded-xl border border-kant-staerk bg-white px-3 text-[15px]"
            >
              {(["telefon", "email", "andet"] as const).map((k) => (
                <option key={k} value={k}>
                  {KLAGE_KANAL_NAVN[k]}
                </option>
              ))}
            </select>
          </div>
        )}
        <label htmlFor={`${uid}-note`} className="block text-xs font-medium text-neutral-600">
          {noteType === "kontakt_firma" ? A.kontaktLabel : A.noteLabel}
        </label>
        <textarea
          id={`${uid}-note`}
          value={noteTekst}
          maxLength={KLAGE_NOTE_MAKS}
          onChange={(e) => setNoteTekst(e.target.value)}
          className={FELT}
        />
        <button
          type="button"
          onClick={gemNote}
          disabled={gemmer || !noteTekst.trim()}
          aria-busy={gemmer || undefined}
          className="btn btn-sekundaer"
        >
          {gemmer && <span className="btn-spinner" aria-hidden="true" />}
          {noteType === "kontakt_firma" ? A.knapLogKontakt : A.knapGemNote}
        </button>
      </div>

      {!afsluttet && (
        <div className="space-y-2 rounded-xl border border-neutral-200 p-4">
          <h3 className="font-sans text-base font-semibold text-neutral-900">{A.afgoerTitel}</h3>
          <p className="text-sm text-neutral-600">{A.afgoerForklaring}</p>
          <label htmlFor={`${uid}-begrundelse`} className="block text-xs font-medium text-neutral-600">
            {A.begrundelseLabel}
          </label>
          <textarea
            id={`${uid}-begrundelse`}
            value={begrundelse}
            maxLength={KLAGE_BEGRUNDELSE_MAKS}
            onChange={(e) => setBegrundelse(e.target.value)}
            className={FELT}
          />
          <div className="flex flex-wrap gap-2">
            <BekraeftDialog
              triggerLabel={A.knapBerettiget}
              triggerClassName="btn btn-fare"
              title={A.knapBerettiget}
              description={A.bekraeftBerettiget}
              confirmLabel={A.knapBerettiget}
              confirmDisabled={!begrundelse.trim()}
              onConfirm={() => afgoer("berettiget")}
              onSuccess={() => router.refresh()}
            />
            <BekraeftDialog
              triggerLabel={A.knapIkkeBerettiget}
              triggerClassName="btn btn-sekundaer"
              title={A.knapIkkeBerettiget}
              description={A.bekraeftIkkeBerettiget}
              confirmLabel={A.knapIkkeBerettiget}
              confirmDisabled={!begrundelse.trim()}
              onConfirm={() => afgoer("ikke_berettiget")}
              onSuccess={() => router.refresh()}
            />
          </div>
        </div>
      )}

      {besked && (
        <p role={besked.fejl ? "alert" : "status"} className={`text-sm font-medium ${besked.fejl ? "text-fejl-tekst" : "text-succes-tekst"}`}>
          {besked.tekst}
        </p>
      )}
    </div>
  );
}
