"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

// Kompakt ?q=-søgefelt til toppen af admin-listesider.
export default function AdminSearchInput({
  placeholder = "Søg...",
}: {
  placeholder?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <div className="relative">
      <svg
        viewBox="0 0 24 24"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
      </svg>
      <input
        type="text"
        placeholder={placeholder}
        defaultValue={searchParams.get("q") ?? ""}
        onChange={(e) => {
          const params = new URLSearchParams(searchParams.toString());
          if (e.target.value) params.set("q", e.target.value);
          else params.delete("q");
          router.push(pathname + (params.size ? `?${params}` : ""));
        }}
        className="w-full rounded-lg border border-neutral-200 py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
      />
    </div>
  );
}
