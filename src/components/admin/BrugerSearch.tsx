"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

// Den store primære brugersøgning på "Søg bruger"-siden.
export default function BrugerSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <div className="relative">
      <svg
        viewBox="0 0 24 24"
        className="pointer-events-none absolute left-4 top-1/2 h-6 w-6 -translate-y-1/2 text-neutral-400"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
      </svg>
      <input
        type="text"
        autoFocus
        placeholder="Søg efter navn, e-mail eller telefon..."
        defaultValue={searchParams.get("q") ?? ""}
        onChange={(e) => {
          const params = new URLSearchParams(searchParams.toString());
          if (e.target.value) params.set("q", e.target.value);
          else params.delete("q");
          router.push(pathname + (params.size ? `?${params}` : ""));
        }}
        className="h-14 w-full rounded-xl border border-neutral-200 bg-white pl-12 pr-4 text-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-brand"
      />
    </div>
  );
}
