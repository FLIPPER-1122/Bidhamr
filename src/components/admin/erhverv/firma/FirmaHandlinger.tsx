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
import {
  annullerUgensButikAction,
  bookUgensButikAction,
  saetUgensButikFirmaRabatAction,
} from "@/app/actions/adminUgensButik";
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
  label,
  className = "btn btn-primaer btn-lille",
}: {
  firmaId: string;
  // Genaktivér har sin egen dialog med begrundelse (GenaktiverKnap).
  handling: "gensendVelkomst";
  label: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [fejl, setFejl] = useState<string | null>(null);
  function koer() {
    setFejl(null);
    start(async () => {
      const svar = await gensendFirmaVelkomst(firmaId);
      if ("fejl" in svar) {
        setFejl(svar.fejl);
        return;
      }
      visKvittering(T.kraever.velkomstSendt);
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

// --- Genaktivér (fra "Kræver handling") - med begrundelse som StatusKort ----------

export function GenaktiverKnap({ firmaId }: { firmaId: string }) {
  const router = useRouter();
  const [grund, setGrund] = useState("");
  const G = T.hurtig.genaktiver;
  return (
    <BekraeftDialog
      triggerClassName="btn btn-primaer btn-lille"
      triggerLabel={T.kraever.genaktiver}
      title={G.dialog}
      description={G.forklaring}
      confirmLabel={T.kraever.genaktiver}
      confirmDisabled={!grund.trim()}
      onConfirm={async () => {
        const b = grund.trim();
        if (!b) return { fejl: T.hurtig.status.skrivBegrundelse };
        const svar = await opdaterFirma({ firmaId, status: "aktiv", note: b });
        if ("fejl" in svar) return { fejl: svar.fejl };
        visKvittering(T.kraever.genaktiveret);
      }}
      onSuccess={() => {
        setGrund("");
        router.refresh();
      }}
    >
      <Begrundelse value={grund} onChange={setGrund} label={G.begrundelse} pladsholder={G.begrundelsePladsholder} />
    </BekraeftDialog>
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
  // Den igangværende uge (kan også bookes med betaling - prisen er den samme
  // hele ugen, og reservationen holder højst til ugens slutning).
  denne_uge: boolean;
};

export function BookUgeKnap({
  firmaId,
  uger,
  startUge,
  trigger,
  medBetalingMulig,
}: {
  firmaId: string;
  uger: LedigUge[];
  startUge?: string;
  // Med betaling kræver et aktivt firma (ikke på pause eller suspenderet).
  // Uden betaling kan altid bookes, så længe kontoen ikke er lukket.
  medBetalingMulig: boolean;
  // "kort" = hurtighandlingen; "lille" = knappen i kalenderen.
  trigger: "kort" | "lille";
}) {
  const router = useRouter();
  const id = useId();
  const [uge, setUge] = useState(startUge ?? uger[0]?.uge_start ?? "");
  const valgtUge = uger.find((u) => u.uge_start === uge) ?? null;
  // "ja" gælder kun, hvor det er muligt (aktivt firma, prisen er hentet).
  const [betaling, setBetaling] = useState<"ja" | "nej">("ja");
  const [grund, setGrund] = useState("");
  const [omgaaLoft, setOmgaaLoft] = useState(false);
  const medMulig = medBetalingMulig && !!valgtUge && valgtUge.inkl_oere != null;
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
        fd.set("omgaaLoft", omgaaLoft ? "ja" : "nej");
        const svar = await bookUgensButikAction(fd);
        if ("fejl" in svar) return { fejl: svar.fejl };
        visKvittering(svar.status === "reserveret" ? T.hurtig.uge.reserveret : T.hurtig.uge.booket);
      }}
      onSuccess={() => {
        // Næste booking starter forfra (med betaling, hvor det er muligt).
        setGrund("");
        setBetaling("ja");
        setOmgaaLoft(false);
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
              medBetalingMulig ? T.hurtig.uge.medBetalingIngenPris : T.hurtig.uge.medBetalingIkkeAktiv
            )}
          </Valg>
          <Valg name="betaling" value="nej" valgt={med ? "ja" : "nej"} onVaelg={() => setBetaling("nej")}>
            {T.hurtig.uge.udenBetaling}
          </Valg>
        </fieldset>
        <label className="flex items-start gap-3 border border-kant px-3 py-2.5 text-sm text-tekst">
          <input
            type="checkbox"
            checked={omgaaLoft}
            onChange={(e) => setOmgaaLoft(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-groen"
          />
          <span className="min-w-0">
            <span className="font-semibold">{T.hurtig.uge.omgaaLoft}</span>
            <span className="block text-tekst-daempet">{T.hurtig.uge.omgaaLoftForklaring}</span>
          </span>
        </label>
        <Begrundelse
          value={grund}
          onChange={setGrund}
          label={T.hurtig.uge.begrundelse}
          pladsholder={omgaaLoft ? T.hurtig.uge.begrundelseLoftPladsholder : T.hurtig.uge.begrundelsePladsholder}
        />
      </div>
    </BekraeftDialog>
  );
}

// --- Firmaets rabat på Ugens butik ------------------------------------------------

export type FirmaRabatTilstand = {
  // Pakkens rabat (standard for firmaet).
  pakkeProcent: number;
  pakkeAntal: number;
  // Firmaets egen rabat (tilsidesætter pakkens). null = følger pakken.
  egen: { procent: number; antal: number; begrundelse: string | null; opdateret_kl: string | null; opdateret_af_navn: string | null } | null;
};

const HELTAL = /^\d{1,2}$/;

export function UgensRabatKort({ firmaId, rabat, trigger }: { firmaId: string; rabat: FirmaRabatTilstand; trigger: "kort" | "knap" }) {
  const router = useRouter();
  const id = useId();
  const R = T.hurtig.rabat;
  const [valg, setValg] = useState<"pakke" | "egen">(rabat.egen ? "egen" : "pakke");
  const [procent, setProcent] = useState(String(rabat.egen?.procent ?? rabat.pakkeProcent));
  const [antal, setAntal] = useState(String(rabat.egen?.antal ?? rabat.pakkeAntal));
  const [grund, setGrund] = useState("");
  const nu = rabat.egen ? R.nuEgen(rabat.egen.procent, rabat.egen.antal) : R.nuPakke(rabat.pakkeProcent, rabat.pakkeAntal);
  const heltal = (v: string, max: number) => HELTAL.test(v.trim()) && Number(v) <= max;
  const gyldig = valg === "pakke" || (heltal(procent, 90) && heltal(antal, 52));
  return (
    <BekraeftDialog
      triggerClassName={trigger === "kort" ? KORT : "btn btn-sekundaer btn-lille"}
      triggerIcon={trigger === "kort" ? <KortTitel>{R.titel}</KortTitel> : undefined}
      triggerLabel={trigger === "kort" ? nu : R.ret}
      title={R.dialog}
      description={R.forklaring}
      confirmLabel={R.bekraeft}
      confirmDisabled={!gyldig || !grund.trim() || (valg === "pakke" && !rabat.egen)}
      onConfirm={async () => {
        const fd = new FormData();
        fd.set("firmaId", firmaId);
        fd.set("procent", valg === "pakke" ? "" : procent.trim());
        fd.set("antal", valg === "pakke" ? "" : antal.trim());
        fd.set("begrundelse", grund.trim());
        const svar = await saetUgensButikFirmaRabatAction(fd);
        if ("fejl" in svar) return { fejl: svar.fejl };
        visKvittering(R.gemt);
      }}
      onSuccess={() => {
        setGrund("");
        router.refresh();
      }}
    >
      <div className="space-y-3">
        <p className="bg-groen-lys px-3 py-2 text-sm text-groen-mork">
          {R.nu}: {nu}
          {rabat.egen?.begrundelse && <span className="block text-tekst-daempet">{rabat.egen.begrundelse}</span>}
        </p>
        <fieldset className="space-y-2">
          <legend className="sr-only">{R.titel}</legend>
          <Valg name="rabat" value="pakke" valgt={valg} onVaelg={(v) => setValg(v as "pakke" | "egen")}>
            {R.foelgPakken(rabat.pakkeProcent, rabat.pakkeAntal)}
          </Valg>
          <Valg name="rabat" value="egen" valgt={valg} onVaelg={(v) => setValg(v as "pakke" | "egen")}>
            {R.egen}
          </Valg>
        </fieldset>
        {valg === "egen" && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-pct`} className={LABEL}>
                {R.procent}
              </label>
              <input id={`${id}-pct`} inputMode="numeric" value={procent} onChange={(e) => setProcent(e.target.value)} className={FELT} />
            </div>
            <div>
              <label htmlFor={`${id}-antal`} className={LABEL}>
                {R.antal}
              </label>
              <input id={`${id}-antal`} inputMode="numeric" value={antal} onChange={(e) => setAntal(e.target.value)} className={FELT} />
            </div>
            {!gyldig && <p className="col-span-2 text-xs font-medium text-fejl-tekst">{R.ugyldig}</p>}
          </div>
        )}
        <Begrundelse value={grund} onChange={setGrund} label={R.begrundelse} pladsholder={R.begrundelsePladsholder} />
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
