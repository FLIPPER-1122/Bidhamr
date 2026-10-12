"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useRouter } from "next/navigation";
import { visKvittering } from "@/components/admin/Kvittering";
import Skabeloner, { type Skabelon } from "@/components/admin/Skabeloner";

type Props = {
  triggerLabel: string;
  triggerIcon?: ReactNode;
  triggerClassName?: string;
  title: string;
  description?: string;
  confirmLabel: string;
  action: (formData: FormData) => Promise<void | { fejl: string } | { ok: true }>;
  hiddenFields: Record<string, string>;
  aarsagField?: {
    label: string;
    placeholder: string;
    required: boolean;
    name?: string;
    skabeloner?: readonly Skabelon[];
  };
  varighedField?: boolean;
  // Påkrævet valg mellem nogle muligheder (radioknapper), fx Køber/Sælger.
  valgField?: { name: string; label: string; valg: { value: string; label: string }[] };
  // Flere tekstfelter, fx "Begrundelse til brugeren" + "Intern note" ved advarsler.
  // Vises i den angivne rækkefølge efter aarsagField.
  tekstFelter?: TekstFelt[];
  // Gør et tekstfelt påkrævet, når et bestemt valg er markeret, fx at
  // begrundelsen "Andet" kræver en uddybning. Tjekkes i browseren før afsendelse.
  valgKraeverTekst?: { valg: string; felt: string; besked: string };
  // Rullelister, fx "Hvilken regel bryder det?" ved DSA-indgreb. Vises efter
  // valgField og før tekstfelterne.
  vaelgFelter?: VaelgFelt[];
  // Et afkrydsningsfelt nederst (sendes som value, når det er krydset af).
  afkrydsning?: { name: string; label: string; value?: string };
  // Kort kvittering, der vises nederst på skærmen (<Kvittering /> i
  // admin/layout.tsx), når handlingen er lykkedes - fx "Anmeldelsen er afsluttet".
  kvittering?: string;
  // De vigtigste fakta øverst i dialogen (beløb, hvem får pengene, hvem det
  // gælder), så man ikke skal åbne en detaljeside for at være sikker.
  fakta?: { label: string; vaerdi: ReactNode }[];
  // Destruktiv handling eller handling, der flytter penge: rød bekræftknap.
  fare?: boolean;
  // Viser "Kan ikke fortrydes." ved knapperne.
  kanIkkeFortrydes?: boolean;
  // Ekstra knap "... og gå til næste": samme handling, og derefter videre
  // til næste element i samme kø.
  naeste?: { href: string; label?: string };
};

export type VaelgFelt = {
  name: string;
  label: string;
  valg: { value: string; label: string }[];
  required?: boolean;
  standard?: string;
  // Tekst på den tomme første mulighed, når der ikke er et standardvalg.
  pladsholder?: string;
  hjaelp?: string;
};

export type TekstFelt = {
  name: string;
  label: string;
  placeholder?: string;
  required: boolean;
  maxLength?: number;
  // Kort forklaring under feltet, fx hvem der kan se teksten.
  hjaelp?: string;
  // Forudfyldt tekst.
  standard?: string;
  // Standardsvar, der kan sættes ind med ét klik (src/lib/tekster/adminSkabeloner.ts).
  skabeloner?: readonly Skabelon[];
};

export default function ConfirmDialog({
  triggerLabel,
  triggerIcon,
  triggerClassName,
  title,
  description,
  confirmLabel,
  action,
  hiddenFields,
  aarsagField,
  varighedField,
  valgField,
  tekstFelter,
  valgKraeverTekst,
  vaelgFelter,
  afkrydsning,
  kvittering,
  fakta,
  fare = false,
  kanIkkeFortrydes = false,
  naeste,
}: Props) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [fejl, setFejl] = useState<string | null>(null);
  const [valgt, setValgt] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const annullerRef = useRef<HTMLButtonElement>(null);
  const varAaben = useRef(false);

  // Fokus ind i dialogen ved åbning (på Annullér - det sikre valg), og
  // tilbage til knappen, der åbnede den, når den lukkes.
  useEffect(() => {
    if (open) {
      varAaben.current = true;
      annullerRef.current?.focus();
    } else if (varAaben.current) {
      varAaben.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  function luk() {
    if (!pending) setOpen(false);
  }

  // Esc lukker, og Tab holdes inde i dialogen.
  function onDialogKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      luk();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const fokuserbare = [
      ...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ];
    if (fokuserbare.length === 0) return;
    const foerste = fokuserbare[0];
    const sidste = fokuserbare[fokuserbare.length - 1];
    const aktiv = document.activeElement;
    if (e.shiftKey && (aktiv === foerste || !dialogRef.current.contains(aktiv))) {
      e.preventDefault();
      sidste.focus();
    } else if (!e.shiftKey && (aktiv === sidste || !dialogRef.current.contains(aktiv))) {
      e.preventDefault();
      foerste.focus();
    }
  }

  // onSubmit + preventDefault i stedet for <form action>: React 19 nulstiller
  // formularen efter en action, så valg og tekst ville forsvinde ved en
  // serverfejl. Her bevares felterne, indtil handlingen lykkes.
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    // Hvilken knap sendte formularen? "... og gå til næste" har name="__naeste".
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const videre = !!naeste && submitter?.name === "__naeste";
    const formData = new FormData(form);
    if (valgKraeverTekst && formData.get(valgField?.name ?? "") === valgKraeverTekst.valg) {
      const tekst = String(formData.get(valgKraeverTekst.felt) ?? "").trim();
      if (!tekst) {
        setFejl(valgKraeverTekst.besked);
        form.querySelector<HTMLTextAreaElement>(`textarea[name="${valgKraeverTekst.felt}"]`)?.focus();
        return;
      }
    }
    startTransition(async () => {
      setFejl(null);
      const res = await action(formData);
      if (res && "fejl" in res) {
        setFejl(res.fejl);
        return;
      }
      if (kvittering) visKvittering(kvittering);
      setOpen(false);
      setValgt(null);
      if (videre && naeste) router.push(naeste.href);
    });
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={
          triggerClassName ??
          "btn btn-sekundaer btn-lille"
        }
      >
        {triggerIcon}
        {triggerLabel}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
          onClick={luk}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-titel`}
            aria-describedby={description ? `${id}-beskrivelse` : undefined}
            onKeyDown={onDialogKeyDown}
            className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 text-left shadow-stor sm:rounded-2xl sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={`${id}-titel`} className="text-lg font-bold text-tekst">{title}</h2>
            {description && (
              <p id={`${id}-beskrivelse`} className="mt-1.5 text-sm text-tekst-daempet">{description}</p>
            )}
            {fakta && fakta.length > 0 && (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl bg-groen-lys px-4 py-3 text-sm">
                {fakta.map((f) => (
                  <div key={f.label} className="contents">
                    <dt className="text-tekst-daempet">{f.label}</dt>
                    <dd className="min-w-0 break-words font-semibold text-tekst">{f.vaerdi}</dd>
                  </div>
                ))}
              </dl>
            )}

            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              {fejl && (
                <p role="alert" className="rounded-lg border border-fejl-kant bg-fejl-bg px-3 py-2 text-sm text-fejl-tekst">
                  {fejl}
                </p>
              )}

              {Object.entries(hiddenFields).map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))}

              {varighedField && (
                <div>
                  <label
                    htmlFor="varighed"
                    className="block text-sm font-medium text-tekst"
                  >
                    Hvor længe?
                  </label>
                  <select
                    id="varighed"
                    name="varighed"
                    required
                    className="mt-1.5 w-full rounded-lg border border-kant-staerk px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-groen bg-white"
                  >
                    <option value="1">1 dag</option>
                    <option value="7">7 dage</option>
                    <option value="permanent">Permanent</option>
                  </select>
                </div>
              )}

              {valgField && (
                <fieldset>
                  <legend className="block text-sm font-medium text-tekst">
                    {valgField.label}
                  </legend>
                  <div className="mt-1.5 flex flex-wrap gap-4">
                    {valgField.valg.map((v) => (
                      <label key={v.value} className="inline-flex items-center gap-2 text-sm text-tekst">
                        <input
                          type="radio"
                          name={valgField.name}
                          value={v.value}
                          required
                          onChange={() => setValgt(v.value)}
                        />
                        {v.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              {vaelgFelter?.map((f) => {
                const feltId = `${id}-${f.name}`;
                return (
                  <div key={f.name}>
                    <label htmlFor={feltId} className="block text-sm font-medium text-tekst">
                      {f.label}
                    </label>
                    <select
                      id={feltId}
                      name={f.name}
                      required={f.required !== false}
                      defaultValue={f.standard ?? ""}
                      aria-describedby={f.hjaelp ? `${feltId}-hjaelp` : undefined}
                      className="mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-groen"
                    >
                      {!f.standard && (
                        <option value="" disabled>
                          {f.pladsholder ?? "Vælg …"}
                        </option>
                      )}
                      {f.valg.map((v) => (
                        <option key={v.value} value={v.value}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                    {f.hjaelp && (
                      <p id={`${feltId}-hjaelp`} className="mt-1 text-xs text-tekst-svag">
                        {f.hjaelp}
                      </p>
                    )}
                  </div>
                );
              })}

              {aarsagField && (
                <div>
                  <label
                    htmlFor={`${id}-aarsag`}
                    className="block text-sm font-medium text-tekst"
                  >
                    {aarsagField.label}
                  </label>
                  {aarsagField.skabeloner && (
                    <Skabeloner skabeloner={aarsagField.skabeloner} feltId={`${id}-aarsag`} />
                  )}
                  <textarea
                    id={`${id}-aarsag`}
                    name={aarsagField.name ?? "aarsag"}
                    required={aarsagField.required}
                    rows={3}
                    placeholder={aarsagField.placeholder}
                    className="mt-1.5 w-full rounded-lg border border-kant-staerk px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-groen"
                  />
                </div>
              )}

              {tekstFelter?.map((f) => {
                const feltId = `${id}-${f.name}`;
                const paakraevet =
                  f.required ||
                  (valgKraeverTekst?.felt === f.name && valgt === valgKraeverTekst.valg);
                return (
                  <div key={f.name}>
                    <label htmlFor={feltId} className="block text-sm font-medium text-tekst">
                      {f.label}
                      {!paakraevet && <span className="font-normal text-tekst-svag"> (valgfri)</span>}
                    </label>
                    {f.skabeloner && <Skabeloner skabeloner={f.skabeloner} feltId={feltId} />}
                    <textarea
                      id={feltId}
                      name={f.name}
                      required={paakraevet}
                      aria-required={paakraevet || undefined}
                      maxLength={f.maxLength}
                      rows={3}
                      placeholder={f.placeholder}
                      defaultValue={f.standard}
                      aria-describedby={f.hjaelp ? `${feltId}-hjaelp` : undefined}
                      className="mt-1.5 w-full rounded-lg border border-kant-staerk px-3 py-2.5 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-groen"
                    />
                    {f.hjaelp && (
                      <p id={`${feltId}-hjaelp`} className="mt-1 text-xs text-tekst-svag">
                        {f.hjaelp}
                      </p>
                    )}
                  </div>
                );
              })}

              {afkrydsning && (
                <label className="flex items-start gap-2 text-sm text-tekst">
                  <input
                    type="checkbox"
                    name={afkrydsning.name}
                    value={afkrydsning.value ?? "ja"}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-groen"
                  />
                  {afkrydsning.label}
                </label>
              )}

              {kanIkkeFortrydes && <p className="text-sm font-medium text-fejl-tekst">Kan ikke fortrydes.</p>}
              {/* Bekræft står FØRST i DOM'en, så Enter i et felt altid rammer den -
                  aldrig "... og gå til næste". Placeringen styres med CSS order. */}
              <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap sm:justify-end sm:gap-3">
                <button
                  type="submit"
                  disabled={pending}
                  aria-busy={pending}
                  className={`btn order-1 sm:order-3 ${fare ? "btn-fare-fyldt" : "btn-primaer"}`}
                >
                  {pending && <span className="btn-spinner" aria-hidden="true" />}
                  {confirmLabel}
                </button>
                {naeste && (
                  <button
                    type="submit"
                    name="__naeste"
                    value="1"
                    disabled={pending}
                    aria-busy={pending}
                    className={`btn order-2 ${fare ? "btn-fare" : "btn-sekundaer"}`}
                  >
                    {naeste.label ?? `${confirmLabel} og gå til næste`}
                  </button>
                )}
                <button ref={annullerRef} type="button" onClick={luk} disabled={pending} className="btn btn-sekundaer order-3 sm:order-1">
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
