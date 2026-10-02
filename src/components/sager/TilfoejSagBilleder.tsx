"use client";

// Køberen tilføjer flere billeder til sin åbne sag.
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { tilfoejSagBilleder } from "@/app/actions/sager";
import { SAG_BILLEDE_KATEGORIER } from "@/lib/sager";
import BilledVaelger, { KATEGORI_FELTER, useFrigivPreviews } from "./BilledVaelger";
import { uploadBilleder, type ValgtBillede } from "./sagUpload";

const FELTER = SAG_BILLEDE_KATEGORIER.map((k) => ({ ...KATEGORI_FELTER[k], paakraevet: false }));

export default function TilfoejSagBilleder({
  sagId,
  tradeId,
  koeberId,
  pladsTilbage,
}: {
  sagId: string;
  tradeId: string;
  koeberId: string;
  pladsTilbage: number;
}) {
  const router = useRouter();
  const [aaben, setAaben] = useState(false);
  const [billeder, setBilleder] = useState<ValgtBillede[]>([]);
  const [sender, setSender] = useState(false);
  const [fremskridt, setFremskridt] = useState<string | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const [sendt, setSendt] = useState(false);
  const laas = useRef(false);
  useFrigivPreviews(billeder);

  if (pladsTilbage <= 0) {
    return <p className="text-sm text-tekst-svag">Sagen har det højeste antal billeder.</p>;
  }

  async function send() {
    if (laas.current || billeder.length === 0) return;
    laas.current = true;
    setSender(true);
    setFejl(null);
    try {
      const up = await uploadBilleder(koeberId, tradeId, billeder, (faerdige, ialt) =>
        setFremskridt(`Uploader billeder: ${faerdige} af ${ialt}`),
      );
      setBilleder(up.billeder);
      if ("fejl" in up) {
        setFejl(up.fejl);
        return;
      }
      setFremskridt("Gemmer…");
      const res = await tilfoejSagBilleder(
        sagId,
        up.billeder.map((b) => ({ sti: b.sti!, kategori: b.kategori })),
      );
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      up.billeder.forEach((b) => URL.revokeObjectURL(b.preview));
      setBilleder([]);
      setAaben(false);
      setSendt(true);
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
      <div>
        <button
          type="button"
          onClick={() => {
            setSendt(false);
            setAaben(true);
          }}
          className="btn btn-sekundaer"
        >
          Tilføj billeder
        </button>
        {sendt && (
          <p role="status" className="mt-2 text-sm text-succes-tekst">
            Billederne er tilføjet sagen.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-kant p-4">
      <h3 className="text-sm font-semibold text-tekst">Tilføj billeder til sagen</h3>
      <BilledVaelger
        felter={FELTER}
        billeder={billeder}
        onChange={setBilleder}
        maks={pladsTilbage}
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
          disabled={sender || billeder.length === 0}
          aria-busy={sender}
          className="btn btn-primaer"
        >
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          Send billeder
        </button>
      </div>
    </div>
  );
}
