"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { sendPakke, markerModtaget, godkendPakke } from "@/app/actions/trades";
import BekraeftDialog from "@/components/BekraeftDialog";
import StjerneVaelger from "@/components/StjerneVaelger";
import BilledVaelger, { type KategoriFelt, useFrigivPreviews } from "@/components/sager/BilledVaelger";
import { uploadBilleder, type ValgtBillede } from "@/components/sager/sagUpload";
import {
  PAKKE_BUCKET,
  PAKKE_KATEGORI_NAVN,
  PAKKE_MAKS_BILLEDER,
  type PakkeBilledeKategori,
} from "@/lib/pakkebilleder";

// Pakkebilleder (ROADMAP-BESLUTNINGER: "Pakkebilleder (krævet)"): de
// dokumenterer indpakningen og bruges af BidHamr i sager. Mobilen åbner
// kameraet direkte (capture="environment").
const PAKKE_FELTER: KategoriFelt<PakkeBilledeKategori>[] = [
  {
    kategori: "aaben_kasse",
    overskrift: PAKKE_KATEGORI_NAVN.aaben_kasse,
    hjaelp: "Tag billedet ovenfra, mens kassen er åben, så både varen og fyldet omkring den kan ses.",
    paakraevet: true,
  },
  {
    kategori: "lukket_kasse",
    overskrift: PAKKE_KATEGORI_NAVN.lukket_kasse,
    hjaelp: "Hele kassen, lukket og tapet. Har du sat en label på eller skrevet koden på kassen, skal den kunne ses.",
    paakraevet: true,
  },
];

export function SendPakkeForm({
  tradeId,
  saelgerId,
  forslagTracking,
}: {
  tradeId: string;
  saelgerId: string;
  // Sporingsnummeret fra en fragtlabel lavet i BidHamr (kun når
  // FRAGT_LABELS_AKTIV=true). Uden det er feltet tomt som altid.
  forslagTracking?: string | null;
}) {
  const router = useRouter();
  const [tracking, setTracking] = useState(forslagTracking ?? "");
  const [billeder, setBilleder] = useState<ValgtBillede<PakkeBilledeKategori>[]>([]);
  const [fejl, setFejl] = useState<string | null>(null);
  const [fremskridt, setFremskridt] = useState<string | null>(null);
  const [sender, setSender] = useState(false);
  const laas = useRef(false);
  useFrigivPreviews(billeder);

  const harAlleBilleder = PAKKE_FELTER.every((f) => billeder.some((b) => b.kategori === f.kategori));
  const klar = harAlleBilleder && tracking.trim().length > 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (laas.current || !klar) return;
    laas.current = true;
    setSender(true);
    setFejl(null);
    try {
      const up = await uploadBilleder(
        saelgerId,
        tradeId,
        billeder,
        (faerdige, ialt) => setFremskridt(`Uploader billeder: ${faerdige} af ${ialt}`),
        PAKKE_BUCKET,
      );
      setBilleder(up.billeder);
      if ("fejl" in up) {
        setFejl(up.fejl);
        return;
      }
      setFremskridt("Gemmer…");
      const resultat = await sendPakke(
        tradeId,
        tracking,
        up.billeder.map((b) => ({ sti: b.sti!, kategori: b.kategori })),
      );
      if ("fejl" in resultat) {
        setFejl(resultat.fejl ?? "Noget gik galt. Prøv igen om lidt.");
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

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded-lg bg-groen-lys px-4 py-3 text-sm text-tekst-daempet">
        <p className="font-medium text-tekst">Sådan pakker du godt</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>Brug en solid kasse, der er lidt større end varen.</li>
          <li>Fyld tomrummet ud (fx bobleplast eller avispapir), så varen ikke kan rykke sig.</li>
          <li>Pak skrøbelige ting ind hver for sig, og tape kassen godt til.</li>
        </ul>
        <p className="mt-2">
          Tag billederne med kameraet, mens du pakker. De viser, hvordan du har pakket varen, og
          BidHamr bruger dem, hvis der bliver oprettet en sag. Du har altid selv ansvaret for at pakke
          varen godt.
        </p>
      </div>

      <BilledVaelger
        felter={PAKKE_FELTER}
        billeder={billeder}
        onChange={setBilleder}
        maks={PAKKE_MAKS_BILLEDER}
        laast={sender}
        kamera
      />

      <div>
        <label htmlFor="tracking" className="block text-sm font-medium text-tekst-daempet">
          Sporingsnummer
        </label>
        <input
          id="tracking"
          type="text"
          value={tracking}
          onChange={(e) => setTracking(e.target.value)}
          placeholder="Fx 00570012345678"
          maxLength={100}
          disabled={sender}
          className="min-h-11 mt-1.5 w-full rounded-xl border border-kant-staerk px-4 py-2.5 text-[15px] bg-white text-tekst placeholder:text-pladsholder hover:border-[#BFBFBF] focus:border-groen focus:outline-2 focus:outline-groen/25"
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
      <button
        type="submit"
        disabled={sender || !klar}
        className="btn btn-primaer"
      >
        {sender ? "Gemmer…" : "Marker som sendt"}
      </button>
      {!klar && !sender && (
        <p className="text-xs text-tekst-svag">
          Tag begge billeder, og skriv sporingsnummeret. Så kan du markere pakken som sendt.
        </p>
      )}
    </form>
  );
}

// TRIN 1: kvittering for pakken. Ingen penge flyttes, så ingen dialog -
// handlingen kan ikke gøre skade og skal være let at komme videre fra.
export function MarkerModtagetKnap({ tradeId }: { tradeId: string }) {
  const router = useRouter();
  const [fejl, setFejl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleClick() {
    setFejl(null);
    startTransition(async () => {
      const resultat = await markerModtaget(tradeId);
      if (resultat?.fejl) setFejl(resultat.fejl);
      else router.refresh();
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="btn btn-primaer"
      >
        {pending ? "Gemmer…" : "Jeg har modtaget pakken"}
      </button>
      {fejl && <p className="mt-2 text-sm text-fejl-tekst">{fejl}</p>}
    </div>
  );
}

const KOMMENTAR_MAKS = 1000;

// TRIN 2: godkendelse udbetaler til sælgeren og kan ikke fortrydes - derfor
// bekræftelsesdialogen. Køberen bedømmer sælgeren i samme trin
// (ROADMAP-BESLUTNINGER afsnit 6): stjerner er påkrævet, kommentaren valgfri.
export function GodkendPakkeKnap({ tradeId }: { tradeId: string }) {
  const router = useRouter();
  const [stjerner, setStjerner] = useState(0);
  const [kommentar, setKommentar] = useState("");
  const antalTegn = Array.from(kommentar).length;

  return (
    <BekraeftDialog
      triggerLabel="Godkend pakke"
      title="Godkend varen og bedøm sælgeren"
      description="Din bedømmelse vises på sælgerens profil. Når du godkender, får sælgeren pengene. Betalingen håndteres af vores betalingspartner Stripe. Du kan ikke fortryde en godkendelse."
      confirmLabel="Godkend og bedøm"
      confirmDisabled={stjerner === 0 || antalTegn > KOMMENTAR_MAKS}
      onConfirm={() => godkendPakke(tradeId, stjerner, kommentar)}
      onSuccess={() => router.refresh()}
    >
      <div className="space-y-4">
        <StjerneVaelger
          legend="Hvordan var handlen med sælgeren?"
          vaerdi={stjerner}
          onChange={setStjerner}
        />
        <div>
          <label
            htmlFor={`kommentar-${tradeId}`}
            className="mb-1.5 block text-sm font-medium text-tekst"
          >
            Kommentar <span className="font-normal text-tekst-svag">(valgfrit)</span>
          </label>
          <textarea
            id={`kommentar-${tradeId}`}
            value={kommentar}
            onChange={(e) => setKommentar(e.target.value)}
            maxLength={KOMMENTAR_MAKS}
            rows={3}
            placeholder="Fortæl kort om din oplevelse"
            aria-describedby={`kommentar-taeller-${tradeId}`}
            className="w-full resize-none rounded-xl border border-kant-staerk bg-white px-4 py-2.5 text-[15px] text-tekst placeholder:text-pladsholder focus:border-groen focus:outline-2 focus:outline-groen/25"
          />
          <p
            id={`kommentar-taeller-${tradeId}`}
            className="mt-1 text-right text-xs text-tekst-svag"
          >
            {antalTegn}/{KOMMENTAR_MAKS} tegn
          </p>
        </div>
      </div>
    </BekraeftDialog>
  );
}
