"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

interface AdminFiltersProps {
  sortOptions: { value: string; label: string }[];
  searchPlaceholder?: string;
}

export default function AdminFilters({ sortOptions, searchPlaceholder = "Søg..." }: AdminFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const createQueryString = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      Object.entries(updates).forEach(([key, value]) => {
        if (value) {
          params.set(key, value);
        } else {
          params.delete(key);
        }
      });
      return params.toString();
    },
    [searchParams]
  );

  return (
    <div className="flex flex-col sm:flex-row gap-3">
      <input
        type="text"
        placeholder={searchPlaceholder}
        defaultValue={searchParams.get("q") ?? ""}
        onChange={(e) => {
          router.push(pathname + "?" + createQueryString({ q: e.target.value }));
        }}
        className="border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E63946] flex-1"
      />
      {sortOptions.length > 0 && (
        <select
          defaultValue={searchParams.get("sort") ?? ""}
          onChange={(e) => {
            router.push(pathname + "?" + createQueryString({ sort: e.target.value }));
          }}
          className="border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#E63946] bg-white"
        >
          <option value="">Sorter</option>
          {sortOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
