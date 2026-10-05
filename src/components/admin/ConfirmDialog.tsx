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

type Props = {
  triggerLabel: string;
  triggerIcon?: ReactNode;
  triggerClassName?: string;
  title: string;
  description?: string;
  confirmLabel: string;
  action: (formData: FormData) => Promise<void | { fejl: string } | { ok: true }>;
  hiddenFields: Record<string, string>;
  aarsagField?: { label: string; placeholder: string; required: boolean; name?: string };
  varighedField?: boolean;
  // Påkrævet valg mellem nogle muligheder (radioknapper), fx Køber/Sælger.
  valgField?: { name: string; label: string; valg: { value: string; label: string }[] };
  // Flere tekstfelter, fx "Begrundelse til brugeren" + "Intern note" ved advarsler.
  // Vises i den angivne rækkefølge efter aarsagField.
  tekstFelter?: TekstFelt[];
  // Gør et tekstfelt påkrævet, når et bestemt valg er markeret, fx at
  // begrundelsen "Andet" kræver en uddybning. Tjekkes i browseren før afsendelse.
  valgKraeverTekst?: { valg: string; felt: string; besked: string };
};

export type TekstFelt = {
  name: string;
  label: string;
  placeholder?: string;
  required: boolean;
  maxLength?: number;
  // Kort forklaring under feltet, fx hvem der kan se teksten.
  hjaelp?: string;
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
}: Props) {
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
      setOpen(false);
      setValgt(null);
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
          "inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 transition-colors"
        }
      >
        {triggerIcon}
        {triggerLabel}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={luk}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-titel`}
            aria-describedby={description ? `${id}-beskrivelse` : undefined}
            onKeyDown={onDialogKeyDown}
            className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl bg-white p-6 text-left shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={`${id}-titel`} className="text-lg font-bold text-neutral-900">{title}</h2>
            {description && (
              <p id={`${id}-beskrivelse`} className="mt-1.5 text-sm text-neutral-500">{description}</p>
            )}

            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              {fejl && (
                <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
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
                    className="block text-sm font-medium text-neutral-700"
                  >
                    Hvor længe?
                  </label>
                  <select
                    id="varighed"
                    name="varighed"
                    required
                    className="mt-1.5 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-groen bg-white"
                  >
                    <option value="1">1 dag</option>
                    <option value="7">7 dage</option>
                    <option value="permanent">Permanent</option>
                  </select>
                </div>
              )}

              {valgField && (
                <fieldset>
                  <legend className="block text-sm font-medium text-neutral-700">
                    {valgField.label}
                  </legend>
                  <div className="mt-1.5 flex flex-wrap gap-4">
                    {valgField.valg.map((v) => (
                      <label key={v.value} className="inline-flex items-center gap-2 text-sm text-neutral-800">
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

              {aarsagField && (
                <div>
                  <label
                    htmlFor="aarsag"
                    className="block text-sm font-medium text-neutral-700"
                  >
                    {aarsagField.label}
                  </label>
                  <textarea
                    id="aarsag"
                    name={aarsagField.name ?? "aarsag"}
                    required={aarsagField.required}
                    rows={3}
                    placeholder={aarsagField.placeholder}
                    className="mt-1.5 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-groen"
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
                    <label htmlFor={feltId} className="block text-sm font-medium text-neutral-700">
                      {f.label}
                      {!paakraevet && <span className="font-normal text-neutral-500"> (valgfri)</span>}
                    </label>
                    <textarea
                      id={feltId}
                      name={f.name}
                      required={paakraevet}
                      aria-required={paakraevet || undefined}
                      maxLength={f.maxLength}
                      rows={3}
                      placeholder={f.placeholder}
                      aria-describedby={f.hjaelp ? `${feltId}-hjaelp` : undefined}
                      className="mt-1.5 w-full rounded-lg border border-neutral-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-groen"
                    />
                    {f.hjaelp && (
                      <p id={`${feltId}-hjaelp`} className="mt-1 text-xs text-neutral-500">
                        {f.hjaelp}
                      </p>
                    )}
                  </div>
                );
              })}

              <div className="flex justify-end gap-3 pt-1">
                <button
                  ref={annullerRef}
                  type="button"
                  onClick={luk}
                  disabled={pending}
                  className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-200 transition-colors disabled:opacity-50"
                >
                  Annullér
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-lg bg-orange-knap px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-knap-mork transition-colors disabled:opacity-50"
                >
                  {pending ? "Arbejder…" : confirmLabel}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
