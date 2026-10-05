"use client";

// Den part, der tabte sagen, anker afgørelsen: begrundelse (påkrævet) og
// gerne ny dokumentation (billeder). Billederne uploades først til
// 'sag-billeder' i brugerens egen mappe, derefter sendes anken.
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { indgivAnke } from "@/app/actions/sager";
import {
  SAG_ANKE_BEGRUNDELSE_MAKS,
  SAG_ANKE_BEGRUNDELSE_MIN,
  SAG_ANKE_MAKS_BILLEDER,
} from "@/lib/sager";
import BilledVaelger, { useFrigivPreviews, type KategoriFelt } from "./BilledVaelger";
import { uploadBilleder, type ValgtBillede } from "./sagUpload";

const FELTER: KategoriFelt[] = [
  {
    kategori: "andet",
    overskrift: "Ny dokumentation (valgfri)",
    hjaelp: "Fx billeder af varen, kvitteringer eller skærmbilleder, der viser, hvorfor afgørelsen er forkert.",
    paakraevet: false,
  },
];

export default function AnkeForm({
  sagId,
  tradeId,
  brugerId,
  fristTekst,
}: {
  sagId: string;
  tradeId: string;
  brugerId: string;
  // Fx "7. oktober kl. 14.05".
  fristTekst: string;
}) {
  const router = useRouter();
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const [tekst, setTekst] = useState("");
  const [billeder, setBilleder] = useState<ValgtBillede[]>([]);
  const [sender, setSender] = useState(false);
  const [fremskridt, setFremskridt] = useState<string | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const laas = useRef(false);
  useFrigivPreviews(billeder);

  const laengde = tekst.trim().length;
  const forKort = laengde < SAG_ANKE_BEGRUNDELSE_MIN;

  async function send() {
    if (laas.current) return;
    if (forKort) {
      setFejl(`Skriv mindst ${SAG_ANKE_BEGRUNDELSE_MIN} tegn om, hvorfor du anker.`);
      return;
    }
    laas.current = true;
    setSender(true);
    setFejl(null);
    try {
      let stier: { sti: string; kategori: "andet" }[] = [];
      if (billeder.length > 0) {
        const up = await uploadBilleder(brugerId, tradeId, billeder, (faerdige, ialt) =>
          setFremskridt(`Uploader billeder: ${faerdige} af ${ialt}`),
        );
        setBilleder(up.billeder);
        if ("fejl" in up) {
          setFejl(up.fejl);
          return;
        }
        stier = up.billeder.map((b) => ({ sti: b.sti!, kategori: "andet" as const }));
      }
      setFremskridt("Sender anken…");
      const res = await indgivAnke(sagId, tekst, stier);
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      billeder.forEach((b) => URL.revokeObjectURL(b.preview));
      setBilleder([]);
      setAaben(false);
      router.refresh();
    } catch {
      setFejl("Noget gik galt. Prøv igen om lidt.");
    } finally {
      laas.current = false;
      setSender(false);
      setFremskridt(null);
    }
  }

  if (!aaben) {
    return (
      <button
        type="button"
        onClick={() => {
          setFejl(null);
          setAaben(true);
        }}
        className="btn btn-sekundaer"
      >
        Anke afgørelsen
      </button>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-kant bg-white p-4">
      <div>
        <h3 className="text-sm font-semibold text-tekst">Anke afgørelsen</h3>
        <p className="mt-1 text-sm text-tekst-daempet">
          En anden medarbejder ser på sagen igen. Pengene flyttes ikke, mens anken behandles. Du kan kun anke én
          gang, og afgørelsen på anken er endelig. Fristen er {fristTekst}.
        </p>
      </div>
      <div>
        <label htmlFor={`${id}-tekst`} className="block text-sm font-medium text-tekst">
          Hvorfor er afgørelsen forkert?
        </label>
        <textarea
          id={`${id}-tekst`}
          value={tekst}
          onChange={(e) => setTekst(e.target.value)}
          rows={5}
          maxLength={SAG_ANKE_BEGRUNDELSE_MAKS}
          disabled={sender}
          aria-describedby={`${id}-hj`}
          className="min-h-11 mt-1.5 w-full rounded-xl border border-kant-staerk px-4 py-2.5 text-base sm:text-sm bg-white text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
        />
        <p id={`${id}-hj`} className="mt-1 text-xs text-tekst-svag">
          Mindst {SAG_ANKE_BEGRUNDELSE_MIN} tegn. {laengde} / {SAG_ANKE_BEGRUNDELSE_MAKS}
        </p>
      </div>
      <BilledVaelger
        felter={FELTER}
        billeder={billeder}
        onChange={setBilleder}
        maks={SAG_ANKE_MAKS_BILLEDER}
        laast={sender}
      />
      {fejl && (
        <p role="alert" className="rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
      {fremskridt && (
        <p role="status" aria-live="polite" className="text-sm text-tekst-daempet">
          {fremskridt}
        </p>
      )}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={() => {
            billeder.forEach((b) => URL.revokeObjectURL(b.preview));
            setBilleder([]);
            setFejl(null);
            setAaben(false);
          }}
          disabled={sender}
          className="btn btn-sekundaer"
        >
          Annullér
        </button>
        <button
          type="button"
          onClick={send}
          disabled={sender || forKort}
          aria-busy={sender}
          className="btn btn-primaer"
        >
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          Send anke
        </button>
      </div>
    </div>
  );
}
