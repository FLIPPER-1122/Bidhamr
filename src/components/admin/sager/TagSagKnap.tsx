"use client";

// "Tag sagen" på en almindelig sag (listen og selve sagen): ét klik + kvittering.
// Har en anden sagen, står der "Taget af X", og man kan overtage den efter en
// kort bekræftelse. Har man den selv, kan man slippe den. Serveren
// (tagSag/slipSag -> sag_tag/sag_slip) tjekker rolle og inhabilitet igen.
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import { visKvittering } from "@/components/admin/Kvittering";
import { slipSag, tagSag } from "@/app/actions/adminSagTag";

const lille =
  "inline-flex min-h-10 items-center whitespace-nowrap rounded-lg border border-kant-staerk bg-white px-3 text-[13px] font-medium text-tekst transition-colors hover:bg-admin-bg disabled:opacity-60 lg:min-h-9";

function tid(iso: string) {
  return new Date(iso).toLocaleString("da-DK", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Copenhagen" });
}

export default function TagSagKnap({
  sagId,
  taget: fraServer,
  mig,
  inhabil = false,
}: {
  sagId: string;
  taget: { brugerId: string; navn: string | null; kl: string } | null;
  // Den indloggede staffs id (til "Du har sagen").
  mig: string;
  inhabil?: boolean;
}) {
  const router = useRouter();
  const [gemmer, start] = useTransition();
  const [fejl, setFejl] = useState<string | null>(null);
  const laas = useRef(false);
  // Optimistisk: knappen skifter, så snart handlingen er lykkedes - før
  // siden er hentet igen. undefined = brug serverens værdi.
  const [lokal, setLokal] = useState<{ brugerId: string; navn: string | null; kl: string } | null | undefined>(undefined);
  const taget = lokal !== undefined ? lokal : fraServer;

  function koer(
    fn: () => Promise<{ ok: true } | { fejl: string }>,
    kvittering: string,
    efter: { brugerId: string; navn: string | null; kl: string } | null,
  ) {
    if (laas.current) return;
    laas.current = true;
    setFejl(null);
    start(async () => {
      try {
        const svar = await fn();
        if ("fejl" in svar) {
          setFejl(svar.fejl);
          router.refresh();
          return;
        }
        setLokal(efter);
        visKvittering(kvittering);
        router.refresh();
      } finally {
        laas.current = false;
      }
    });
  }

  if (inhabil) {
    return <span className="text-xs text-tekst-svag">Du er inhabil: du er part i handlen eller har handlet med en af parterne.</span>;
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {!taget ? (
        <button type="button" disabled={gemmer} aria-busy={gemmer} onClick={() => koer(() => tagSag(sagId), "Du har taget sagen", { brugerId: mig, navn: null, kl: new Date().toISOString() })} className={lille}>
          {gemmer && <span className="btn-spinner" aria-hidden="true" />}
          Tag sagen
        </button>
      ) : taget.brugerId === mig ? (
        <>
          <span className="text-xs font-semibold text-succes-tekst">Du har sagen</span>
          <button type="button" disabled={gemmer} onClick={() => koer(() => slipSag(sagId), "Du har sluppet sagen", null)} className={lille}>
            Slip
          </button>
        </>
      ) : (
        <>
          <span className="text-xs font-semibold text-advarsel-tekst">
            Taget af {taget.navn ?? "en kollega"} · {tid(taget.kl)}
          </span>
          <BekraeftDialog
            triggerLabel="Overtag"
            triggerClassName={lille}
            title="Overtag sagen?"
            description={`${taget.navn ?? "En kollega"} har taget sagen ${tid(taget.kl)}. Tal gerne med ${taget.navn ?? "kollegaen"} først, så I ikke arbejder på den samtidig.`}
            confirmLabel="Overtag sagen"
            onConfirm={async () => {
              const svar = await tagSag(sagId, true);
              if ("fejl" in svar) return { fejl: svar.fejl };
              setLokal({ brugerId: mig, navn: null, kl: new Date().toISOString() });
              visKvittering("Du har overtaget sagen");
              router.refresh();
            }}
          />
        </>
      )}
      {fejl && (
        <span role="alert" className="basis-full text-xs font-medium text-fejl-tekst">
          {fejl}
        </span>
      )}
    </span>
  );
}
