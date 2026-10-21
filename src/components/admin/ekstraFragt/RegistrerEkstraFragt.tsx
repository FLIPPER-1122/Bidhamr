"use client";

// "Registrér ekstra fragt" på handlens admin-side (ROADMAP-BESLUTNINGER,
// "For lille pakkestørrelse – sælgeren betaler forskellen"). Én kort
// formular: beløb, fragtfirmaets måling, fakturanummer, forklaring og
// fragtfirmaets faktura (kun udsnittet med pakken). Filen uploades direkte
// fra browseren til den private bucket via en signeret URL
// (forberedEkstraFragtUpload) - den går ikke gennem en server action.
// Databasen tjekker rolle, to-trins-login, inhabilitet og alle regler igen
// (opretEkstraFragt -> ekstra_fragt_opret). Ingen penge flyttes: sælgeren
// får en regning og betaler selv.
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { forberedEkstraFragtUpload, opretEkstraFragt } from "@/app/actions/adminEkstraFragt";
import { visKvittering } from "@/components/admin/Kvittering";
import { createClient } from "@/lib/supabase/client";
import { STOERRELSE_NAVN, kgTilGram, kronerTilOere, type MaaltStoerrelse } from "@/lib/ekstraFragt/tekster";
import { valgtStoerrelseNavn } from "@/lib/ekstraFragt/visning";
import { transportoerNavn } from "@/lib/fragt/types";
import { useHydreret } from "@/lib/useHydreret";

const BUCKET = "ekstra-fragt-dokumentation";
const MAKS_BYTES = 10 * 1024 * 1024;
const GENERISK = "Noget gik galt. Prøv igen, eller kontakt en udvikler.";
const FELT =
  "mt-1.5 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-groen sm:text-sm";

export type EkstraFragtForsendelse = {
  id: string;
  sporingsnummer: string | null;
  transportoer: string | null;
  pakkestoerrelse: string | null;
  // Der er allerede en åben regning på pakken (databasen afviser en til).
  harAabenRegning: boolean;
};

// Browserens filtype - HEIC har ofte ingen type, så endelsen bruges.
function filtype(fil: File): string {
  const t = (fil.type || "").toLowerCase();
  if (t) return t === "image/jpg" ? "image/jpeg" : t;
  const endelse = fil.name.split(".").pop()?.toLowerCase();
  return endelse === "heic" || endelse === "heif" ? "image/heic" : endelse === "pdf" ? "application/pdf" : "";
}

function visKr(oere: number): string {
  return (oere / 100).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " kr.";
}

export default function RegistrerEkstraFragt({
  tradeId,
  forsendelser,
}: {
  tradeId: string;
  forsendelser: EkstraFragtForsendelse[];
}) {
  const id = useId();
  const router = useRouter();
  const hydreret = useHydreret();
  const [aaben, setAaben] = useState(false);
  const ledige = forsendelser.filter((f) => !f.harAabenRegning);
  const [forsendelseId, setForsendelseId] = useState(ledige[0]?.id ?? "");
  const [beloeb, setBeloeb] = useState("");
  const [vaegt, setVaegt] = useState("");
  const [sender, setSender] = useState(false);
  const [trin, setTrin] = useState<string | null>(null);
  const [fejl, setFejl] = useState<string | null>(null);
  const laas = useRef(false);
  const fejlRef = useRef<HTMLParagraphElement>(null);

  if (forsendelser.length === 0) {
    return (
      <p className="text-sm text-tekst-daempet">
        Ekstra fragt kan kun registreres på en sendt pakke til køberen (labelen er lavet).
      </p>
    );
  }
  if (ledige.length === 0) {
    return <p className="text-sm text-tekst-daempet">Der er allerede en åben regning for ekstra fragt på pakken.</p>;
  }

  const valgt = ledige.find((f) => f.id === forsendelseId) ?? ledige[0];
  const beloebOere = beloeb.trim() ? kronerTilOere(beloeb) : null;
  const vaegtGram = vaegt.trim() ? kgTilGram(vaegt) : null;

  function visFejl(t: string) {
    setFejl(t);
    requestAnimationFrame(() => fejlRef.current?.focus());
  }

  async function indsend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (laas.current) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const v = (k: string) => String(fd.get(k) ?? "").trim();
    const fil = fd.get("fil");
    const stoerrelse = v("stoerrelse") as MaaltStoerrelse | "";

    if (beloebOere === null) return visFejl("Skriv beløbet i kroner, fx 35,00.");
    if (beloebOere < 300 || beloebOere > 1_000_000) return visFejl("Beløbet skal være mellem 3,00 kr. og 10.000,00 kr.");
    if (!stoerrelse && !vaegt.trim()) return visFejl("Skriv fragtfirmaets måling: størrelse eller vægt.");
    if (vaegt.trim() && vaegtGram === null) return visFejl("Skriv vægten i kg, fx 7,2.");
    if (!v("fakturanummer")) return visFejl("Skriv fragtfirmaets fakturanummer.");
    if (!(fil instanceof File) || fil.size === 0) return visFejl("Vælg fragtfirmaets faktura (PDF eller billede).");
    if (fil.size > MAKS_BYTES) return visFejl("Filen er større end 10 MB. Gem kun udsnittet med denne pakke.");
    const type = filtype(fil);
    if (!type) return visFejl("Upload fragtfirmaets faktura som PDF eller billede (JPG, PNG, WEBP, HEIC).");
    if (fd.get("kunDennePakke") !== "ja") return visFejl("Bekræft, at filen kun viser denne pakke.");

    laas.current = true;
    setSender(true);
    setFejl(null);
    try {
      setTrin("Uploader fakturaen…");
      const upload = await forberedEkstraFragtUpload({ tradeId, filtype: type });
      if ("fejl" in upload) return visFejl(upload.fejl);
      const { error: upFejl } = await createClient()
        .storage.from(BUCKET)
        .uploadToSignedUrl(upload.sti, upload.token, fil, { contentType: type });
      if (upFejl) return visFejl("Filen kunne ikke uploades. Prøv igen.");

      setTrin("Opretter regningen…");
      const res = await opretEkstraFragt({
        forsendelseId: valgt.id,
        beloebKr: beloeb,
        maaltStoerrelse: stoerrelse || null,
        maaltVaegtKg: vaegt.trim() || null,
        maaltMaal: v("maal") || null,
        fakturanummer: v("fakturanummer"),
        forklaring: v("forklaring") || null,
        dokumentationSti: upload.sti,
        dokumentationType: type,
        dokumentationNavn: fil.name.slice(0, 200),
      });
      if ("fejl" in res) return visFejl(res.fejl);
      form.reset();
      setBeloeb("");
      setVaegt("");
      setAaben(false);
      visKvittering("Regningen er oprettet. Sælgeren får besked nu.", {
        link: res.id ? { href: `/admin/ekstra-fragt/${res.id}`, label: "Se regningen" } : undefined,
      });
      router.refresh();
    } catch {
      visFejl(GENERISK);
    } finally {
      laas.current = false;
      setSender(false);
      setTrin(null);
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
        className="btn btn-sekundaer w-full sm:w-auto"
      >
        Registrér ekstra fragt
      </button>
    );
  }

  return (
    <form onSubmit={indsend} method="post" noValidate aria-busy={sender || undefined} className="space-y-4">
      <p className="text-sm text-tekst-daempet">
        Fragtfirmaet har opkrævet ekstra, fordi pakken var større eller tungere end den valgte størrelse. Sælgeren får
        besked og betaler selv forskellen inden for 14 dage.
      </p>

      {ledige.length > 1 ? (
        <div>
          <label htmlFor={`${id}-fs`} className="block text-sm font-medium text-tekst">
            Pakke
          </label>
          <select
            id={`${id}-fs`}
            value={valgt.id}
            onChange={(e) => setForsendelseId(e.target.value)}
            disabled={sender}
            className={`${FELT} h-11 bg-white`}
          >
            {ledige.map((f) => (
              <option key={f.id} value={f.id}>
                {[transportoerNavn(f.transportoer), f.sporingsnummer, `valgt: ${valgtStoerrelseNavn(f.pakkestoerrelse)}`]
                  .filter(Boolean)
                  .join(" · ")}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="rounded-lg border border-admin-kant px-3 py-2 text-sm text-tekst">
          Pakke: {[transportoerNavn(valgt.transportoer), valgt.sporingsnummer].filter(Boolean).join(" · ") || "Pakke til køber"}
          <span className="block text-tekst-daempet">Sælgeren valgte: {valgtStoerrelseNavn(valgt.pakkestoerrelse)}</span>
        </p>
      )}

      <div>
        <label htmlFor={`${id}-beloeb`} className="block text-sm font-medium text-tekst">
          Beløb i kr. (inkl. moms)
        </label>
        <input
          id={`${id}-beloeb`}
          name="beloeb"
          inputMode="decimal"
          autoComplete="off"
          placeholder="Fx 35,00"
          value={beloeb}
          onChange={(e) => setBeloeb(e.target.value)}
          disabled={sender}
          aria-describedby={`${id}-beloeb-tolket`}
          className={FELT}
        />
        <p id={`${id}-beloeb-tolket`} aria-live="polite" className="mt-1 text-sm">
          {beloeb.trim() === "" ? (
            <span className="text-tekst-svag">Forskellen, som fragtfirmaet har opkrævet.</span>
          ) : beloebOere === null ? (
            <span className="font-medium text-fejl-tekst">Kan ikke læses som et beløb.</span>
          ) : (
            <span className="font-semibold text-tekst">= {visKr(beloebOere)}</span>
          )}
        </p>
      </div>

      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <legend className="mb-1 text-sm font-medium text-tekst">Fragtfirmaets måling (størrelse og/eller vægt)</legend>
        <div>
          <label htmlFor={`${id}-st`} className="block text-xs text-tekst-daempet">
            Målt størrelse
          </label>
          <select id={`${id}-st`} name="stoerrelse" defaultValue="" disabled={sender} className={`${FELT} h-11 bg-white`}>
            <option value="">Ikke oplyst</option>
            {Object.entries(STOERRELSE_NAVN).map(([k, navn]) => (
              <option key={k} value={k}>
                {navn}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-vaegt`} className="block text-xs text-tekst-daempet">
            Målt vægt i kg
          </label>
          <input
            id={`${id}-vaegt`}
            name="vaegt"
            inputMode="decimal"
            autoComplete="off"
            placeholder="Fx 7,2"
            value={vaegt}
            onChange={(e) => setVaegt(e.target.value)}
            disabled={sender}
            className={FELT}
          />
        </div>
        <div>
          <label htmlFor={`${id}-maal`} className="block text-xs text-tekst-daempet">
            Mål (valgfrit)
          </label>
          <input id={`${id}-maal`} name="maal" maxLength={100} autoComplete="off" placeholder="Fx 60 x 40 x 30 cm" disabled={sender} className={FELT} />
        </div>
      </fieldset>

      <div>
        <label htmlFor={`${id}-nr`} className="block text-sm font-medium text-tekst">
          Fragtfirmaets fakturanummer
        </label>
        <input id={`${id}-nr`} name="fakturanummer" maxLength={100} autoComplete="off" disabled={sender} className={FELT} />
      </div>

      <div>
        <label htmlFor={`${id}-fork`} className="block text-sm font-medium text-tekst">
          Forklaring til sælgeren <span className="font-normal text-tekst-svag">(valgfrit)</span>
        </label>
        <textarea
          id={`${id}-fork`}
          name="forklaring"
          rows={2}
          maxLength={1000}
          disabled={sender}
          placeholder="Fx: DAO målte pakken til 7,2 kg – du valgte Mellem (op til 5 kg)."
          className={FELT}
        />
      </div>

      <div>
        <label htmlFor={`${id}-fil`} className="block text-sm font-medium text-tekst">
          Fragtfirmaets dokumentation (PDF eller billede, højst 10 MB)
        </label>
        <p className="mt-1 rounded-lg border border-advarsel-kant bg-advarsel-bg px-3 py-2 text-sm text-advarsel-tekst">
          <strong className="font-semibold">Upload kun udsnittet med denne pakke – ikke hele månedsfakturaen.</strong>{" "}
          Sælgeren kan se filen, så den må ikke vise andre kunders pakker, navne eller adresser.
        </p>
        <input
          id={`${id}-fil`}
          name="fil"
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
          disabled={sender}
          className="mt-2 block w-full text-sm text-tekst file:mr-3 file:min-h-11 file:rounded-lg file:border file:border-admin-kant file:bg-white file:px-4 file:text-sm file:font-semibold file:text-groen"
        />
        <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-2 text-sm text-tekst">
          <input type="checkbox" name="kunDennePakke" value="ja" required disabled={sender} className="mt-0.5 h-5 w-5 shrink-0 accent-groen" />
          <span>Filen viser kun denne pakke – ingen andre kunders oplysninger.</span>
        </label>
      </div>

      {fejl && (
        <p ref={fejlRef} tabIndex={-1} role="alert" className="rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
          {fejl}
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button type="submit" disabled={sender || !hydreret} aria-busy={sender || undefined} className="btn btn-primaer w-full sm:w-auto">
          {sender && <span className="btn-spinner" aria-hidden="true" />}
          {beloebOere !== null ? `Opret regning på ${visKr(beloebOere)}` : "Opret regning"}
        </button>
        <button type="button" onClick={() => setAaben(false)} disabled={sender} className="btn btn-sekundaer w-full sm:w-auto">
          Annullér
        </button>
        {trin && <span className="text-sm text-tekst-daempet">{trin}</span>}
      </div>
    </form>
  );
}
