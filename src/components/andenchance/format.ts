export function kroner(oere: number) {
  return (
    (oere / 100).toLocaleString("da-DK", {
      minimumFractionDigits: oere % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }) + " kr"
  );
}

export function dato(iso: string) {
  return new Date(iso).toLocaleString("da-DK", { dateStyle: "medium", timeStyle: "short" });
}
