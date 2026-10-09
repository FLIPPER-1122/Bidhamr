"use client";

// "Opret sag" på handelssiden (kun køberen). Mulighederne kommer fra
// hentSagMuligheder(); databasen (sag_opret) afgør stadig til sidst.
// Billederne uploades direkte til Storage ved afsendelse, derefter kaldes
// opretSag() med stierne.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { opretSag, type SagMuligheder } from "@/app/actions/sager";
import {
  SAG_BESKRIVELSE_MAKS,
  SAG_BESKRIVELSE_MIN,
  SAG_KRAEVEDE_KATEGORIER,
  SAG_MAKS_BILLEDER,
  SAG_OPRET_FEJL,
  SAG_TYPE_NAVN,
  type SagType,
} from "@/lib/sager";
import BilledVaelger, { KATEGORI_FELTER, useFrigivPreviews, type KategoriFelt } from "./BilledVaelger";
import { uploadBilleder, type ValgtBillede } from "./sagUpload";
import { sagTid } from "./visning";

// Korte forklaringer under hver type.
const TYPE_HJAELP: Record<SagType, string> = {
  bortkommet: "Pakken er ikke kommet frem, selvom den blev sendt for mere end 7 dage siden.",
  skadet: "Varen er gået i stykker under forsendelsen.",
  ikke_som_beskrevet: "Varen er tydeligt anderledes end beskrevet i auktionen.",
  svindel: "Fx en tom pakke, en helt anden vare, en falsk kopi eller en vare, der aldrig er sendt.",
};

export default function OpretSagForm({
  tradeId,
  koeberId,
  muligheder,
}: {
  tradeId: string;
  koeberId: string;
  muligheder: SagMuligheder;
}) {
  const router = useRouter();
  const id = useId();
  const [aaben, setAaben] = useState(false);
  const [type, setType] = useState<SagType | "">(
    muligheder.typer.length === 1 ? muligheder.typer[0] : "",
  );
  const [beskrivelse, setBeskrivelse] = useState("");
  const [billeder, setBilleder] = useState<ValgtBillede[]>([]);
  const [sender, setSender] = useState(false);
  const [fremskridt, setFremskridt] = useState<string | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const laas = useRef(false);
  useFrigivPreviews(billeder);

  const felter: KategoriFelt[] = muligheder.billederKraeves
    ? [
        ...SAG_KRAEVEDE_KATEGORIER.map((k) => ({ ...KATEGORI_FELTER[k], paakraevet: true })),
        { ...KATEGORI_FELTER.andet, paakraevet: false },
      ]
    : [{ ...KATEGORI_FELTER.andet, paakraevet: false }];

  const manglerKategorier = muligheder.billederKraeves
    ? SAG_KRAEVEDE_KATEGORIER.filter((k) => !billeder.some((b) => b.kategori === k))
    : [];
  const tekstLaengde = beskrivelse.trim().length;

  async function send(e: FormEvent) {
    e.preventDefault();
    if (laas.current) return;
    setFejl(null);
    if (!type) {
      setFejl(SAG_OPRET_FEJL.ugyldig_type);
      return;
    }
    if (tekstLaengde < SAG_BESKRIVELSE_MIN || tekstLaengde > SAG_BESKRIVELSE_MAKS) {
      setFejl(SAG_OPRET_FEJL.ugyldig_beskrivelse);
      return;
    }
    if (manglerKategorier.length > 0) {
      setFejl(SAG_OPRET_FEJL.billeder_kraeves);
      return;
    }
    laas.current = true;
    setSender(true);
    try {
      let klar = billeder;
      if (billeder.length > 0) {
        const res = await uploadBilleder(koeberId, tradeId, billeder, (faerdige, ialt) =>
          setFremskridt(`Uploader billeder: ${faerdige} af ${ialt}`),
        );
        setBilleder(res.billeder);
        if ("fejl" in res) {
          setFejl(res.fejl);
          return;
        }
        klar = res.billeder;
      }
      setFremskridt("Opretter sagen…");
      const res = await opretSag(
        tradeId,
        type,
        beskrivelse,
        klar.map((b) => ({ sti: b.sti!, kategori: b.kategori })),
      );
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      router.refresh();
    } catch {
      setFejl("Noget gik galt. Prøv igen om lidt.");
    } finally {
      laas.current = false;
      setSender(false);
      setFremskridt(null);
    }
  }

  const beskyttelseInfo = muligheder.kraeverBeskyttelse.length > 0 && (
    <p className="rounded-xl border border-info-kant bg-info-bg p-3 text-sm text-info-tekst">
      Uden BidHamr Beskyttelse kan du ikke oprette en sag om{" "}
      {muligheder.kraeverBeskyttelse.map((t) => SAG_TYPE_NAVN[t].toLowerCase()).join(" eller ")}. Skriv i stedet
      til sælgeren i chatten herunder.{" "}
      <Link href="/bidhamr-beskyttelse" className="font-semibold underline">
        Læs mere
      </Link>
    </p>
  );

  // Ingen sag kan oprettes lige nu - kun forklaringen om Beskyttelsen.
  if (muligheder.typer.length === 0) {
    return <div>{beskyttelseInfo}</div>;
  }

  return (
    <section aria-labelledby={`${id}-titel`} className="rounded-[14px] border border-kant bg-white p-5 sm:p-6">
      {!aaben ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 id={`${id}-titel`} className="text-sm font-semibold text-tekst">
              Er der noget galt?
            </h2>
            {muligheder.fristKl && (
              <p className="mt-0.5 text-sm text-tekst-daempet">Frist: {sagTid(muligheder.fristKl)}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setAaben(true)}
            className="btn btn-sekundaer w-full shrink-0 sm:w-auto"
          >
            Der er et problem med min vare
          </button>
        </div>
      ) : (
        <>
        <h2 id={`${id}-titel`} className="font-serif text-xl font-semibold text-tekst">
          Der er et problem med min vare
        </h2>
        <p className="mt-1 text-sm text-tekst-daempet">
          Pengene sættes på pause, mens BidHamr ser på sagen.
          {muligheder.fristKl && <> Frist: {sagTid(muligheder.fristKl)}.</>}
        </p>
        {beskyttelseInfo && <div className="mt-4">{beskyttelseInfo}</div>}
        <form onSubmit={send} className="mt-5 space-y-6" noValidate>
          <fieldset>
            <legend className="text-sm font-semibold text-tekst">Hvad drejer sagen sig om?</legend>
            <div className="mt-2 space-y-2">
              {muligheder.typer.map((t) => (
                <label
                  key={t}
                  className={`flex cursor-pointer gap-3 rounded-xl border p-3 text-sm transition-colors ${
                    type === t ? "border-groen bg-groen-lys" : "border-kant-staerk hover:bg-groen-lys"
                  }`}
                >
                  <input
                    type="radio"
                    name="type"
                    value={t}
                    checked={type === t}
                    onChange={() => setType(t)}
                    disabled={sender}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-groen"
                  />
                  <span>
                    <span className="block font-medium text-tekst">{SAG_TYPE_NAVN[t]}</span>
                    <span className="block text-tekst-daempet">{TYPE_HJAELP[t]}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor={`${id}-beskrivelse`} className="block text-sm font-semibold text-tekst">
              Beskriv problemet
            </label>
            <textarea
              id={`${id}-beskrivelse`}
              value={beskrivelse}
              onChange={(e) => setBeskrivelse(e.target.value)}
              required
              rows={5}
              maxLength={SAG_BESKRIVELSE_MAKS}
              disabled={sender}
              aria-describedby={`${id}-beskrivelse-hjaelp`}
              placeholder="Hvad er der galt, og hvornår opdagede du det?"
              className="min-h-11 mt-1.5 w-full rounded-xl border border-kant-staerk px-4 py-2.5 text-base text-tekst placeholder:text-pladsholder sm:text-sm bg-white hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
            />
            <p id={`${id}-beskrivelse-hjaelp`} className="mt-1 flex justify-between gap-3 text-xs text-tekst-svag">
              <span>Mindst {SAG_BESKRIVELSE_MIN} tegn. Sælgeren kan også se beskrivelsen.</span>
              <span>
                {tekstLaengde} / {SAG_BESKRIVELSE_MAKS}
              </span>
            </p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-tekst">Billeder</h3>
            <p className="mb-3 mt-1 text-sm text-tekst-daempet">
              {muligheder.billederKraeves
                ? "Tag billeder af pakken, labelen og indholdet. De bruges til at vurdere sagen."
                : "Har du billeder, der viser problemet, så tilføj dem gerne."}
            </p>
            <BilledVaelger
              felter={felter}
              billeder={billeder}
              onChange={setBilleder}
              maks={SAG_MAKS_BILLEDER}
              laast={sender}
            />
          </div>

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
                setAaben(false);
                setFejl(null);
              }}
              disabled={sender}
              className="btn btn-sekundaer"
            >
              Annullér
            </button>
            <button type="submit" disabled={sender} aria-busy={sender} className="btn btn-primaer">
              {sender && <span className="btn-spinner" aria-hidden="true" />}
              Opret sag
            </button>
          </div>
        </form>
        </>
      )}
    </section>
  );
}
