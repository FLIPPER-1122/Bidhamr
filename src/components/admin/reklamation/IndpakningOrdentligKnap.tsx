"use client";

// "Indpakning var ordentlig" / "Fortryd" på sagens side i admin - ved siden
// af "Dårlig indpakning". Er sagen (eller bliver den) afgjort til køberen,
// opretter databasen reklamationen hos fragtfirmaet, og sælgeren får besked
// (src/app/actions/adminReklamation.ts).
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { fortrydIndpakningOrdentlig, vurderIndpakningOrdentlig } from "@/app/actions/adminReklamation";
import { visKvittering } from "@/components/admin/Kvittering";
import { useHydreret } from "@/lib/useHydreret";

const FELT =
  "mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-groen sm:text-sm";

export default function IndpakningOrdentligKnap({
  sagId,
  tilstand,
  saelgerNavn,
  afgjortTilKoeber,
}: {
  sagId: string;
  // "kan_vurdere": knappen "Indpakning var ordentlig". "ordentlig": vurderet -
  // "Fortryd" (kun så længe sælgeren ikke har anmeldt). "laast": vurderet, og
  // sælgeren har anmeldt - kan ikke fortrydes.
  tilstand: "kan_vurdere" | "ordentlig" | "laast";
  saelgerNavn: string;
  // Sagen er allerede afgjort til køberen -> reklamationen oprettes med det samme.
  afgjortTilKoeber: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const hydreret = useHydreret();
  const [aaben, setAaben] = useState(false);
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState<string | null>(null);
  const laas = useRef(false);
  const boksRef = useRef<HTMLDivElement>(null);
  const fortryd = tilstand === "ordentlig";

  useEffect(() => {
    if (!aaben) return;
    const forrige = document.activeElement as HTMLElement | null;
    boksRef.current?.querySelector<HTMLElement>("textarea, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !laas.current) setAaben(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      forrige?.focus();
    };
  }, [aaben]);

  async function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (laas.current) return;
    const tekst = String(new FormData(e.currentTarget).get("tekst") ?? "").trim();
    if (fortryd && !tekst) {
      setFejl("Skriv, hvorfor vurderingen fortrydes.");
      return;
    }
    laas.current = true;
    setSender(true);
    setFejl(null);
    try {
      const res = fortryd ? await fortrydIndpakningOrdentlig(sagId, tekst) : await vurderIndpakningOrdentlig(sagId, tekst);
      if ("fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      setAaben(false);
      visKvittering(
        fortryd
          ? "Vurderingen er fortrudt"
          : afgjortTilKoeber
            ? "Indpakningen er vurderet ordentlig – sælgeren har fået besked om reklamationen"
            : "Indpakningen er vurderet ordentlig",
      );
      router.refresh();
    } catch {
      setFejl("Noget gik galt. Prøv igen, eller kontakt en udvikler.");
    } finally {
      laas.current = false;
      setSender(false);
    }
  }

  if (tilstand === "laast") {
    return <span className="text-sm text-neutral-600">Indpakning vurderet: ordentlig. Sælgeren har anmeldt skaden.</span>;
  }

  return (
    <>
      {fortryd ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-neutral-600">Indpakning vurderet: ordentlig.</span>
          <button
            type="button"
            onClick={() => {
              setFejl(null);
              setAaben(true);
            }}
            className="btn btn-sekundaer btn-lille"
          >
            Fortryd
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => {
            setFejl(null);
            setAaben(true);
          }}
          className="btn btn-sekundaer"
        >
          Indpakning var ordentlig
        </button>
      )}

      {aaben && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          onClick={() => !sender && setAaben(false)}
        >
          <div
            ref={boksRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-titel`}
            className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={`${id}-titel`} className="text-lg font-bold text-neutral-900">
              {fortryd ? "Fortryd \"ordentlig indpakning\"" : "Indpakningen var ordentlig"}
            </h2>
            <p className="mt-1.5 text-sm text-neutral-600">
              {fortryd
                ? `Reklamationen stoppes, hvis ${saelgerNavn} ikke har anmeldt skaden endnu.`
                : afgjortTilKoeber
                  ? `Skaden skete under fragten. ${saelgerNavn} får nu besked og alle oplysninger, så sælgeren kan få erstatning direkte fra fragtfirmaet.`
                  : `Skaden skete under fragten. Når sagen afgøres til køberen, får ${saelgerNavn} besked og alle oplysninger, så sælgeren kan få erstatning direkte fra fragtfirmaet.`}
            </p>
            <form onSubmit={indsend} method="post" className="mt-4 space-y-4">
              <div>
                <label htmlFor={`${id}-tekst`} className="block text-sm font-medium text-neutral-800">
                  {fortryd ? "Hvorfor fortrydes vurderingen?" : "Intern note"}{" "}
                  {!fortryd && <span className="font-normal text-neutral-500">(valgfri)</span>}
                </label>
                <textarea
                  id={`${id}-tekst`}
                  name="tekst"
                  rows={3}
                  maxLength={fortryd ? 1000 : 2000}
                  required={fortryd}
                  disabled={sender}
                  className={FELT}
                />
                <p className="mt-1 text-xs text-neutral-500">Kun synlig for BidHamr.</p>
              </div>
              {fejl && (
                <p role="alert" className="rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
                  {fejl}
                </p>
              )}
              <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:justify-end">
                <button type="submit" disabled={sender || !hydreret} aria-busy={sender} className="btn btn-primaer order-1 sm:order-2">
                  {sender && <span className="btn-spinner" aria-hidden="true" />}
                  {fortryd ? "Fortryd vurderingen" : "Indpakningen var ordentlig"}
                </button>
                <button type="button" onClick={() => setAaben(false)} disabled={sender} className="btn btn-sekundaer order-2 sm:order-1">
                  Annullér
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
