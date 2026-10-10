"use client";

// Køberens klage over firmaet (handelssiden). Samme upload-mønster som sager:
// billederne vælges med BilledVaelger og uploades først ved afsendelse
// (sagUpload.ts) - her til bucket 'erhverv-klage-billeder' i køberens egen
// mappe. Databasen (erhverv_klage_opret) afgør stadig til sidst.
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { opretErhvervKlage } from "@/app/actions/erhvervKlager";
import BilledVaelger, { useFrigivPreviews, type KategoriFelt } from "@/components/sager/BilledVaelger";
import { uploadBilleder, type ValgtBillede } from "@/components/sager/sagUpload";
import {
  KLAGE_BESKRIVELSE_MAKS,
  KLAGE_BESKRIVELSE_MIN,
  KLAGE_BUCKET,
  KLAGE_KATEGORIER,
  KLAGE_MAKS_BILLEDER,
  type KlageKategori,
} from "@/lib/erhverv/klager";
import { KLAGE_KATEGORI_HJAELP, KLAGE_KATEGORI_NAVN, KLAGE_KOEBER as T } from "@/lib/tekster/erhvervKlager";

type Kat = "andet";
const FELTER: KategoriFelt<Kat>[] = [
  { kategori: "andet", overskrift: T.billederFelt, hjaelp: T.billederHjaelp, paakraevet: false },
];

export default function OpretKlageForm({ tradeId, koeberId }: { tradeId: string; koeberId: string }) {
  const router = useRouter();
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const [kategori, setKategori] = useState<KlageKategori | "">("");
  const [beskrivelse, setBeskrivelse] = useState("");
  const [billeder, setBilleder] = useState<ValgtBillede<Kat>[]>([]);
  const [sender, setSender] = useState(false);
  const [fremskridt, setFremskridt] = useState<string | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [sendt, setSendt] = useState(false);
  const laas = useRef(false);
  useFrigivPreviews(billeder);

  const laengde = beskrivelse.trim().length;

  async function send(e: FormEvent) {
    e.preventDefault();
    if (laas.current) return;
    setFejl(null);
    if (!kategori) {
      setFejl(T.vaelgKategori);
      return;
    }
    if (laengde < KLAGE_BESKRIVELSE_MIN || laengde > KLAGE_BESKRIVELSE_MAKS) {
      setFejl(T.forKortBeskrivelse(KLAGE_BESKRIVELSE_MIN, KLAGE_BESKRIVELSE_MAKS));
      return;
    }
    laas.current = true;
    setSender(true);
    try {
      let klar = billeder;
      if (billeder.length > 0) {
        const res = await uploadBilleder(
          koeberId,
          tradeId,
          billeder,
          (f, i) => setFremskridt(T.uploader(f, i)),
          KLAGE_BUCKET,
        );
        setBilleder(res.billeder);
        if ("fejl" in res) {
          setFejl(res.fejl);
          return;
        }
        klar = res.billeder;
      }
      setFremskridt(T.sender);
      const res = await opretErhvervKlage(
        tradeId,
        kategori,
        beskrivelse,
        klar.map((b) => b.sti!),
      );
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      setSendt(true);
      router.refresh();
    } catch {
      setFejl(T.fejlGenerisk);
    } finally {
      laas.current = false;
      setSender(false);
      setFremskridt(null);
    }
  }

  if (sendt) {
    return (
      <p role="status" className="rounded-xl border border-succes-kant bg-succes-bg p-4 text-[16px] text-succes-tekst">
        {T.sendt}
      </p>
    );
  }

  if (!aaben) {
    return (
      <button type="button" onClick={() => setAaben(true)} className="btn btn-sekundaer btn-stor w-full text-[17px] sm:w-auto">
        {T.knapAaben}
      </button>
    );
  }

  return (
    <form onSubmit={send} className="space-y-6" noValidate aria-labelledby={`${id}-titel`}>
      <h3 id={`${id}-titel`} className="sr-only">
        {T.titel}
      </h3>
      <fieldset>
        <legend className="text-[17px] font-semibold text-tekst">{T.kategoriLegend}</legend>
        <div className="mt-2 space-y-2">
          {KLAGE_KATEGORIER.map((k) => (
            <label
              key={k}
              className={`flex cursor-pointer gap-3 rounded-xl border p-3 text-[16px] transition-colors ${
                kategori === k ? "border-groen bg-groen-lys" : "border-kant-staerk hover:bg-groen-lys"
              }`}
            >
              <input
                type="radio"
                name={`${id}-kategori`}
                value={k}
                checked={kategori === k}
                onChange={() => setKategori(k)}
                disabled={sender}
                className="mt-1 h-5 w-5 shrink-0 accent-groen"
              />
              <span>
                <span className="block font-semibold text-tekst">{KLAGE_KATEGORI_NAVN[k]}</span>
                <span className="block text-tekst-daempet">{KLAGE_KATEGORI_HJAELP[k]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor={`${id}-beskrivelse`} className="block text-[17px] font-semibold text-tekst">
          {T.beskrivelseLabel}
        </label>
        <textarea
          id={`${id}-beskrivelse`}
          value={beskrivelse}
          onChange={(e) => setBeskrivelse(e.target.value)}
          required
          rows={6}
          maxLength={KLAGE_BESKRIVELSE_MAKS}
          disabled={sender}
          aria-describedby={`${id}-beskrivelse-hjaelp`}
          placeholder={T.beskrivelsePladsholder}
          className="mt-1.5 min-h-[140px] w-full rounded-xl border border-kant-staerk bg-white px-4 py-3 text-[16px] text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
        />
        <p id={`${id}-beskrivelse-hjaelp`} className="mt-1 flex justify-between gap-3 text-sm text-tekst-svag">
          <span>{T.beskrivelseHjaelp(KLAGE_BESKRIVELSE_MIN)}</span>
          <span>
            {laengde} / {KLAGE_BESKRIVELSE_MAKS}
          </span>
        </p>
      </div>

      <div>
        <h3 className="text-[17px] font-semibold text-tekst">{T.billederTitel}</h3>
        <div className="mt-3">
          <BilledVaelger<Kat>
            felter={FELTER}
            billeder={billeder}
            onChange={setBilleder}
            maks={KLAGE_MAKS_BILLEDER}
            laast={sender}
          />
        </div>
      </div>

      {fejl && (
        <p role="alert" className="rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-[15px] text-fejl-tekst">
          {fejl}
        </p>
      )}
      {fremskridt && (
        <p role="status" aria-live="polite" className="text-[15px] text-tekst-daempet">
          {fremskridt}
        </p>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={() => {
            setAaben(false);
            setFejl(null);
          }}
          disabled={sender}
          className="btn btn-sekundaer"
        >
          {T.knapAnnuller}
        </button>
        <button type="submit" disabled={sender} aria-busy={sender} className="btn btn-primaer">
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          {T.knapSend}
        </button>
      </div>
    </form>
  );
}
