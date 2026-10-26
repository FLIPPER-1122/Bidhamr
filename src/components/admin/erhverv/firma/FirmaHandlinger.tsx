"use client";

// Handlinger på firmasiden i admin (chef og sælger-rollen - assertErhverv i
// hver server action, og databasen tjekker igen). Penge og destruktive
// handlinger går gennem en dialog med bekræftelse (BekraeftDialog); resten
// er ét klik (docs/ADMIN-REDESIGN.md, færrest klik).
//
// Hurtighandlingerne er kort, der åbner en dialog. Nye kort (fx gratis
// periode, introrabat, særpris, ekstra auktioner og fremhævninger) tilføjes
// som flere komponenter efter samme mønster som SkiftPakkeKort og lægges i
// gitteret i FirmaHurtighandlinger (FirmaOverblik.tsx).
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import BekraeftDialog from "@/components/BekraeftDialog";
import { visKvittering } from "@/components/admin/Kvittering";
import {
  fortrydFirmaOpsigelse,
  gensendFirmaVelkomst,
  opdaterFirma,
  opsigFirmaAbonnement,
} from "@/app/actions/adminErhverv";
import { annullerUgensButikAction, bookUgensButikAction } from "@/app/actions/adminUgensButik";
import { ADMIN_FIRMA as T } from "@/lib/tekster/adminFirma";
import { ABONNEMENT_STATUS_NAVN, type AbonnementStatus } from "@/lib/erhverv/regler";
import { kr, krFraOere } from "@/lib/erhverv/visning";
import { KORT, mandag } from "@/components/admin/erhverv/firma/stil";

const FELT =
  "mt-1.5 w-full border border-kant-staerk bg-white px-3 py-2.5 text-base text-tekst focus:border-groen focus:outline-2 focus:outline-groen/25 sm:text-sm";
const LABEL = "block text-sm font-medium text-tekst";

function KortTitel({ children }: { children: ReactNode }) {
  return <span className="block text-sm font-bold text-tekst">{children}</span>;
}

function Valg({
  name,
  value,
  valgt,
  onVaelg,
  disabled,
  children,
}: {
  name: string;
  value: string;
  valgt: string;
  onVaelg: (v: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      className={`flex items-start gap-3 border px-3 py-2.5 text-sm ${
        disabled
          ? "cursor-not-allowed border-kant text-tekst-svag"
          : valgt === value
            ? "cursor-pointer border-groen bg-groen-lys text-tekst"
            : "cursor-pointer border-kant text-tekst hover:border-groen"
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={valgt === value}
        disabled={disabled}
        onChange={() => onVaelg(value)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-groen"
      />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

function Begrundelse({
  value,
  onChange,
  label,
  pladsholder,
  paakraevet = true,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  pladsholder?: string;
  paakraevet?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={2}
        maxLength={1000}
        required={paakraevet}
        placeholder={pladsholder}
        onChange={(e) => onChange(e.target.value)}
        className={FELT}
      />
    </div>
  );
}

// --- Ét klik --------------------------------------------------------------------

export function EtKlikKnap({
  firmaId,
  handling,
  label,
  className = "btn btn-primaer btn-lille",
}: {
  firmaId: string;
  handling: "genaktiver" | "gensendVelkomst";
  label: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fejl, setFejl] = useState<string | null>(null);
  function koer() {
    setFejl(null);
    start(async () => {
      const svar =
        handling === "genaktiver"
          ? await opdaterFirma({ firmaId, status: "aktiv", note: "Genaktiveret fra Kræver handling" })
          : await gensendFirmaVelkomst(firmaId);
      if ("fejl" in svar) {
        setFejl(svar.fejl);
        return;
      }
      visKvittering(handling === "genaktiver" ? T.kraever.genaktiveret : T.kraever.velkomstSendt);
      router.refresh();
    });
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" onClick={koer} disabled={pending} aria-busy={pending || undefined} className={className}>
        {pending && <span className="btn-spinner" aria-hidden="true" />}
        {label}
      </button>
      {fejl && (
        <p role="alert" className="text-xs font-medium text-fejl-tekst">
          {fejl}
        </p>
      )}
    </div>
  );
}

// --- Skift pakke ----------------------------------------------------------------

export type PakkeValg = {
  id: string;
  navn: string;
  maanedspris: number | null;
  auktioner_pr_uge: number;
  aktiv: boolean;
};

export function SkiftPakkeKort({ firmaId, pakkeId, pakker }: { firmaId: string; pakkeId: string; pakker: PakkeValg[] }) {
  const router = useRouter();
  const [valgt, setValgt] = useState(pakkeId);
  const [note, setNote] = useState("");
  // Skjulte pakker kan ikke vælges - undtagen firmaets nuværende.
  const valg = pakker.filter((p) => p.aktiv || p.id === pakkeId);
  return (
    <BekraeftDialog
      triggerClassName={KORT}
      triggerIcon={<KortTitel>{T.hurtig.pakke.titel}</KortTitel>}
      triggerLabel={T.hurtig.pakke.under}
      title={T.hurtig.pakke.dialog}
      description={T.hurtig.pakke.forklaring}
      confirmLabel={T.hurtig.pakke.bekraeft}
      confirmDisabled={valgt === pakkeId}
      onConfirm={async () => {
        const svar = await opdaterFirma({ firmaId, pakkeId: valgt, note: note.trim() || null });
        if ("fejl" in svar) return { fejl: svar.fejl };
        visKvittering(svar.besked ?? T.hurtig.pakke.skiftet);
      }}
      onSuccess={() => {
        setNote("");
        router.refresh();
      }}
    >
      <div className="space-y-3">
        <fieldset className="space-y-2">
          <legend className="sr-only">{T.hurtig.pakke.titel}</legend>
          {valg.map((p) => (
            <Valg key={p.id} name="pakke" value={p.id} valgt={valgt} onVaelg={setValgt}>
              <span className="font-semibold">{p.navn}</span>
              {p.id === pakkeId && <span className="text-tekst-daempet"> ({T.hurtig.pakke.nu})</span>}
              {!p.aktiv && <span className="text-tekst-daempet"> – {T.hurtig.pakke.skjult}</span>}
              <span className="block text-tekst-daempet">
                {p.maanedspris == null ? T.hurtig.pakke.prisIkkeSat : T.hurtig.pakke.eksklMoms(kr(p.maanedspris))} ·{" "}
                {T.hurtig.pakke.pr(p.auktioner_pr_uge)}
              </span>
            </Valg>
          ))}
        </fieldset>
        <Begrundelse value={note} onChange={setNote} label={T.hurtig.pakke.note} paakraevet={false} />
      </div>
    </BekraeftDialog>
  );
}

// --- Pause, genaktivér eller opsig ------------------------------------------------

type StatusValg = "aktiv" | "pauset" | "opsig" | "fortryd";

export function StatusKort({
  firmaId,
  status,
  opsiges,
}: {
  firmaId: string;
  status: AbonnementStatus;
  // Abonnementet er opsagt i Stripe og stopper ved periodens udgang.
  opsiges: boolean;
}) {
  const router = useRouter();
  const [valgt, setValgt] = useState<StatusValg | "">("");
  const [grund, setGrund] = useState("");

  const muligheder: { v: StatusValg; label: string }[] = [];
  if (status !== "aktiv") {
    muligheder.push({ v: "aktiv", label: status === "pauset" ? T.hurtig.status.aktiv : T.hurtig.status.aktivEfterAftale });
  }
  if (status === "aktiv" || status === "afventer_betaling") muligheder.push({ v: "pauset", label: T.hurtig.status.pause });
  if (opsiges) muligheder.push({ v: "fortryd", label: T.hurtig.status.fortryd });
  else if (status !== "opsagt") muligheder.push({ v: "opsig", label: T.hurtig.status.opsig });

  return (
    <BekraeftDialog
      triggerClassName={KORT}
      triggerIcon={<KortTitel>{T.hurtig.status.titel}</KortTitel>}
      triggerLabel={T.hurtig.status.nu(ABONNEMENT_STATUS_NAVN[status] ?? status)}
      title={T.hurtig.status.dialog}
      confirmLabel={T.hurtig.status.bekraeft}
      confirmDisabled={!valgt || !grund.trim()}
      onConfirm={async () => {
        if (!valgt) return { fejl: T.hurtig.status.vaelg };
        const b = grund.trim();
        if (!b) return { fejl: T.hurtig.status.skrivBegrundelse };
        let besked: string | undefined;
        if (valgt === "aktiv" || valgt === "pauset") {
          const svar = await opdaterFirma({ firmaId, status: valgt, note: b });
          if ("fejl" in svar) return { fejl: svar.fejl };
        } else {
          const svar = valgt === "opsig" ? await opsigFirmaAbonnement(firmaId) : await fortrydFirmaOpsigelse(firmaId);
          if ("fejl" in svar) return { fejl: svar.fejl };
          besked = svar.besked;
          // Begrundelsen logges på firmaet (opsig/fortryd tager ingen tekst).
          await opdaterFirma({ firmaId, note: `${valgt === "opsig" ? "Opsagt" : "Opsigelse fortrudt"}: ${b}` });
        }
        visKvittering(besked ?? T.hurtig.status.gemt);
      }}
      onSuccess={() => {
        setValgt("");
        setGrund("");
        router.refresh();
      }}
    >
      <div className="space-y-3">
        <fieldset className="space-y-2">
          <legend className="sr-only">{T.hurtig.status.dialog}</legend>
          {muligheder.map((m) => (
            <Valg key={m.v} name="status" value={m.v} valgt={valgt} onVaelg={(v) => setValgt(v as StatusValg)}>
              {m.label}
            </Valg>
          ))}
        </fieldset>
        {valgt === "pauset" && <p className="bg-groen-lys px-3 py-2 text-sm text-groen-mork">{T.hurtig.status.pauseInfo}</p>}
        <Begrundelse
          value={grund}
          onChange={setGrund}
          label={T.hurtig.status.begrundelse}
          pladsholder={T.hurtig.status.begrundelsePladsholder}
        />
      </div>
    </BekraeftDialog>
  );
}

// --- Book Ugens butik --------------------------------------------------------------

export type LedigUge = {
  uge_start: string;
  uge_nr: number;
  aar: number;
  // Firmaets pris for ugen (med pakkens rabat). null = prisen kunne ikke hentes.
  inkl_oere: number | null;
  rabat_procent: number;
  // Den igangværende uge kan kun bookes uden betaling (ugens_butik_staff_book).
  denne_uge: boolean;
};

export function BookUgeKnap({
  firmaId,
  uger,
  startUge,
  trigger,
}: {
  firmaId: string;
  uger: LedigUge[];
  startUge?: string;
  // "kort" = hurtighandlingen; "lille" = knappen i kalenderen.
  trigger: "kort" | "lille";
}) {
  const router = useRouter();
  const id = useId();
  const [uge, setUge] = useState(startUge ?? uger[0]?.uge_start ?? "");
  const valgtUge = uger.find((u) => u.uge_start === uge) ?? null;
  // "ja" gælder kun, hvor det er muligt (ikke den igangværende uge) - se med.
  const [betaling, setBetaling] = useState<"ja" | "nej">("ja");
  const [grund, setGrund] = useState("");
  const medMulig = !!valgtUge && !valgtUge.denne_uge && valgtUge.inkl_oere != null;
  const med = betaling === "ja" && medMulig;

  return (
    <BekraeftDialog
      triggerClassName={trigger === "kort" ? KORT : "btn btn-sekundaer btn-lille w-full"}
      triggerIcon={trigger === "kort" ? <KortTitel>{T.hurtig.uge.titel}</KortTitel> : undefined}
      triggerLabel={trigger === "kort" ? T.hurtig.uge.under : T.uger.book}
      title={T.hurtig.uge.dialog}
      confirmLabel={T.hurtig.uge.bekraeft}
      confirmDisabled={!valgtUge || !grund.trim()}
      onConfirm={async () => {
        if (!valgtUge) return { fejl: T.hurtig.status.vaelg };
        const fd = new FormData();
        fd.set("firmaId", firmaId);
        fd.set("uge", valgtUge.uge_start);
        fd.set("medBetaling", med ? "ja" : "nej");
        fd.set("begrundelse", grund.trim());
        const svar = await bookUgensButikAction(fd);
        if ("fejl" in svar) return { fejl: svar.fejl };
        visKvittering(svar.status === "reserveret" ? T.hurtig.uge.reserveret : T.hurtig.uge.booket);
      }}
      onSuccess={() => {
        // Næste booking starter forfra (med betaling, hvor det er muligt).
        setGrund("");
        setBetaling("ja");
        router.refresh();
      }}
    >
      <div className="space-y-3">
        <div>
          <label htmlFor={`${id}-uge`} className={LABEL}>
            {T.hurtig.uge.uge}
          </label>
          <select
            id={`${id}-uge`}
            value={uge}
            onChange={(e) => setUge(e.target.value)}
            className={FELT}
          >
            {uger.map((u) => (
              <option key={u.uge_start} value={u.uge_start}>
                {T.hurtig.uge.ugeNavn(u.uge_nr, u.aar, mandag(u.uge_start))}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="space-y-2">
          <legend className="sr-only">{T.hurtig.uge.under}</legend>
          <Valg name="betaling" value="ja" valgt={med ? "ja" : "nej"} onVaelg={() => setBetaling("ja")} disabled={!medMulig}>
            {medMulig && valgtUge?.inkl_oere != null ? (
              <>
                {T.hurtig.uge.medBetaling(krFraOere(valgtUge.inkl_oere))}
                {valgtUge.rabat_procent > 0 && T.hurtig.uge.medRabat(valgtUge.rabat_procent)}
              </>
            ) : (
              T.hurtig.uge.medBetalingIkkeNu
            )}
          </Valg>
          <Valg name="betaling" value="nej" valgt={med ? "ja" : "nej"} onVaelg={() => setBetaling("nej")}>
            {T.hurtig.uge.udenBetaling}
          </Valg>
        </fieldset>
        <Begrundelse
          value={grund}
          onChange={setGrund}
          label={T.hurtig.uge.begrundelse}
          pladsholder={T.hurtig.uge.begrundelsePladsholder}
        />
      </div>
    </BekraeftDialog>
  );
}

// --- Annullér / refundér en uge ------------------------------------------------------

export function AnnullerUgeKnap({
  bookingId,
  ugeNr,
  slags,
  beloebOere,
}: {
  bookingId: string;
  ugeNr: number;
  // annuller: reserveret/manuel. refunder: betalt -> refunderes.
  // udenRefusion: betalt -> annulleret. refunderSenere: annulleret, betalt -> refunderes.
  slags: "annuller" | "refunder" | "udenRefusion" | "refunderSenere";
  beloebOere: number;
}) {
  const router = useRouter();
  const [grund, setGrund] = useState("");
  const refunder = slags === "refunder" || slags === "refunderSenere";
  const U = T.uger;
  const titel =
    slags === "annuller"
      ? U.annullerTitel(ugeNr)
      : slags === "refunder"
        ? U.refunderTitel(ugeNr)
        : slags === "udenRefusion"
          ? U.udenRefusionTitel(ugeNr)
          : U.refunderSenereTitel(ugeNr);
  const label =
    slags === "annuller" ? U.annuller : slags === "refunder" ? U.refunder : slags === "udenRefusion" ? U.udenRefusion : U.refunderSenere;
  return (
    <BekraeftDialog
      triggerClassName={refunder ? "btn btn-sekundaer btn-lille" : "btn btn-fare btn-lille"}
      triggerLabel={label}
      title={titel}
      description={
        refunder ? U.refunderTekst(krFraOere(beloebOere)) : slags === "udenRefusion" ? U.udenRefusionTekst : U.annullerTekst
      }
      confirmLabel={slags === "annuller" ? U.annullerBekraeft : label}
      confirmDisabled={!grund.trim()}
      onConfirm={async () => {
        const fd = new FormData();
        fd.set("bookingId", bookingId);
        fd.set("begrundelse", grund.trim());
        fd.set("refunder", refunder ? "ja" : "nej");
        const svar = await annullerUgensButikAction(fd);
        if ("fejl" in svar) return { fejl: svar.fejl };
        visKvittering(svar.besked ?? (refunder ? U.refunderet : U.annulleret));
      }}
      onSuccess={() => {
        setGrund("");
        router.refresh();
      }}
    >
      <Begrundelse value={grund} onChange={setGrund} label={U.begrundelse} />
    </BekraeftDialog>
  );
}

// --- Ny note ---------------------------------------------------------------------------

export function FirmaNote({ firmaId }: { firmaId: string }) {
  const router = useRouter();
  const id = useId();
  const [note, setNote] = useState("");
  const [fejl, setFejl] = useState<string | null>(null);
  const [pending, start] = useTransition();
  function gem() {
    const n = note.trim();
    if (!n) {
      setFejl(T.log.skrivNote);
      return;
    }
    setFejl(null);
    start(async () => {
      const svar = await opdaterFirma({ firmaId, note: n });
      if ("fejl" in svar) {
        setFejl(svar.fejl);
        return;
      }
      setNote("");
      visKvittering(T.log.noteGemt);
      router.refresh();
    });
  }
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={id} className={LABEL}>
          {T.log.noteLabel}
        </label>
        <textarea
          id={id}
          value={note}
          rows={2}
          maxLength={1000}
          placeholder={T.log.notePladsholder}
          onChange={(e) => setNote(e.target.value)}
          className={FELT}
        />
      </div>
      {fejl && (
        <p role="alert" className="border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}
      <button type="button" onClick={gem} disabled={pending} aria-busy={pending || undefined} className="btn btn-primaer">
        {pending && <span className="btn-spinner" aria-hidden="true" />}
        {T.log.gemNote}
      </button>
    </div>
  );
}
