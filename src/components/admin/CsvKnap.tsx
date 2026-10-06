"use client";

// Download af en tabel som CSV (semikolon + BOM, så Excel på dansk åbner den
// rigtigt). raekker[0] er overskrifterne.
export default function CsvKnap({ raekker, filnavn }: { raekker: (string | number)[][]; filnavn: string }) {
  function hent() {
    const felt = (v: string | number) => {
      const s = String(v);
      // Undgå formler i regneark (CSV-injection).
      const sikker = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[";\n\r]/.test(sikker) ? `"${sikker.replace(/"/g, '""')}"` : sikker;
    };
    const csv = "﻿" + raekker.map((r) => r.map(felt).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filnavn;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={hent}
      className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
    >
      <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
      Download CSV
    </button>
  );
}
