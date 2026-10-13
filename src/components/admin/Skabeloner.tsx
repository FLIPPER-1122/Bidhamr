"use client";

// Standardsvar over et tekstfelt: ét klik sætter teksten ind, så staff ikke
// skriver det samme igen og igen. Teksten kan rettes bagefter. Felterne er
// ukontrollerede (formularer med FormData), så teksten sættes direkte i
// feltet, og der sendes en input-hændelse, hvis nogen lytter.
export type Skabelon = { label: string; tekst: string };

export default function Skabeloner({
  skabeloner,
  feltId,
  onVaelg,
}: {
  skabeloner: readonly Skabelon[];
  // id på det <textarea>, teksten skal ind i.
  feltId?: string;
  // Til kontrollerede felter: får teksten i stedet.
  onVaelg?: (tekst: string) => void;
}) {
  if (skabeloner.length === 0) return null;

  function vaelg(tekst: string) {
    if (onVaelg) {
      onVaelg(tekst);
    }
    if (!feltId) return;
    const felt = document.getElementById(feltId) as HTMLTextAreaElement | HTMLInputElement | null;
    if (!felt) return;
    if (!onVaelg) {
      // React-sikker måde at sætte værdien på et ukontrolleret felt.
      const proto = felt instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(felt, tekst);
      felt.dispatchEvent(new Event("input", { bubbles: true }));
    }
    felt.focus();
    const slut = tekst.length;
    felt.setSelectionRange?.(slut, slut);
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5" role="group" aria-label="Standardsvar">
      <span className="text-xs text-tekst-svag">Standardsvar:</span>
      {skabeloner.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={() => vaelg(s.tekst)}
          className="inline-flex min-h-10 items-center lg:min-h-8 rounded-full bg-groen-lys px-3 text-xs font-medium text-groen-mork transition-colors hover:bg-groen-lys-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-groen"
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
