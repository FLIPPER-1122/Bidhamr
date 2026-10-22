import { FIRMA, FIRMA_ADRESSE } from "@/lib/firmaoplysninger";

// Firmaoplysningerne på én linje (e-handelsloven § 7): navn, CVR, adresse og
// e-mail. Delene brydes hver for sig på smalle skærme, så linjen aldrig giver
// vandret scroll. Serverkomponent uden JavaScript.
export default function FirmaLinje({ className = "" }: { className?: string }) {
  const dele = [FIRMA.navn, `CVR ${FIRMA.cvr}`, FIRMA_ADRESSE];
  return (
    <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`}>
      {dele.map((d) => (
        <span key={d} className="inline-flex items-center gap-x-2">
          <span className="whitespace-nowrap">{d}</span>
          <span aria-hidden="true">·</span>
        </span>
      ))}
      <a
        href={`mailto:${FIRMA.email}`}
        className="rounded-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-groen"
      >
        {FIRMA.email}
      </a>
    </p>
  );
}
