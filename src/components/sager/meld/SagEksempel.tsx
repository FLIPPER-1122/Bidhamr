// Små tegninger, der viser, hvad billedet skal vise (trin 2 i "Meld et
// problem"). Samme motiver som showcase/opret-sag-showcase.html. Ingen
// "use client" - virker i både server- og klientkomponenter.
import type { SagBilledeKategori } from "@/lib/sager";
import type { SagValgId } from "@/lib/tekster/sagValg";

type Motiv = "pakke" | "knaekket" | "vare" | "anden" | "tom";

// Motivet til et billedfelt: pakken med labelen, eller indholdet for valget.
export function eksempelMotiv(kategori: SagBilledeKategori, valg: SagValgId): Motiv {
  if (kategori === "pakke_label" || kategori === "pakke" || kategori === "label") return "pakke";
  if (valg === "stykker") return "knaekket";
  if (valg === "anden_vare") return "anden";
  if (valg === "tom") return "tom";
  return "vare";
}

export default function SagEksempel({ motiv, className = "h-full w-full" }: { motiv: Motiv; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      {motiv === "pakke" && (
        <>
          <rect width="64" height="64" fill="#E7ECEA" />
          <path d="M10 22 L32 14 L54 22 L54 48 L32 56 L10 48 Z" fill="#C9A36A" stroke="#8B6B3E" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M10 22 L32 30 L54 22 M32 30 L32 56" fill="none" stroke="#8B6B3E" strokeWidth="1.4" />
          <path d="M36 33 L51 27.5 L51 42 L36 47.5 Z" fill="#fff" stroke="#8B6B3E" strokeWidth=".8" />
          <rect x="38" y="33" width="5" height="2.2" fill="#1E5E4A" transform="rotate(-20 38 33)" />
          <g stroke="#1A1A1A" strokeWidth=".9">
            <path d="M38.5 38 L48.5 34.4" />
            <path d="M38.5 40.5 L45 38.2" />
            <path d="M38.5 44 L49 40.2" />
          </g>
        </>
      )}
      {motiv === "knaekket" && (
        <>
          <rect width="64" height="64" fill="#EFE7DB" />
          <g fill="none" stroke="#8B5E34" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 23 C 22 16, 42 16, 49 23" />
            <path d="M17 22 L 20 56" />
            <path d="M47 22 L 45.6 38" />
            <path d="M44.6 46 L 44 56" />
            <path d="M25 41 L 23 57" />
            <path d="M39 41 L 41 57" />
            <path d="M32 40 L 32 31 L 26 22 M 32 31 L 38 22" />
          </g>
          <path d="M43 38.5 L 48 40 L 44 42 L 48.5 44.5 L 44 46" fill="none" stroke="#A32020" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M18 40 L 46 40 L 43 44 L 21 44 Z" fill="#C9A36A" stroke="#8B5E34" strokeWidth="1.4" />
        </>
      )}
      {motiv === "vare" && (
        <>
          <rect width="64" height="64" fill="#F3EDE4" />
          <g fill="none" stroke="#8B5E34" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 23 C 22 16, 42 16, 49 23" />
            <path d="M17 22 L 20 56" />
            <path d="M47 22 L 44 56" />
            <path d="M25 41 L 23 57" />
            <path d="M39 41 L 41 57" />
            <path d="M32 40 L 32 31 L 26 22 M 32 31 L 38 22" />
          </g>
          <path d="M18 40 L 46 40 L 43 44 L 21 44 Z" fill="#C9A36A" stroke="#8B5E34" strokeWidth="1.4" />
          <circle cx="40" cy="30" r="7" fill="none" stroke="#B85518" strokeWidth="1.8" />
        </>
      )}
      {motiv === "anden" && (
        <>
          <rect width="64" height="64" fill="#E7ECEA" />
          <path d="M12 30 L32 38 L52 30 L52 52 L32 60 L12 52 Z" fill="#C9A36A" stroke="#8B6B3E" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M12 30 L32 22 L52 30 L32 38 Z" fill="#5E4626" />
          <g fill="none" stroke="#5B6B7A" strokeWidth="2.4" strokeLinecap="round">
            <path d="M24 30 L26 12 L40 12 L42 30" />
            <path d="M33 12 V6" />
          </g>
        </>
      )}
      {motiv === "tom" && (
        <>
          <rect width="64" height="64" fill="#E7ECEA" />
          <path d="M12 26 L32 34 L52 26 L52 50 L32 58 L12 50 Z" fill="#C9A36A" stroke="#8B6B3E" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M12 26 L32 18 L52 26 L32 34 Z" fill="#5E4626" />
          <path d="M12 26 L4 18 L24 11 L32 18 M52 26 L60 18 L40 11 L32 18" fill="#D8B987" stroke="#8B6B3E" strokeWidth="1.2" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}
