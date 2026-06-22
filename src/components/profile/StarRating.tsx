export default function StarRating({
  gennemsnit,
  antal,
}: {
  gennemsnit: number;
  antal: number;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex">
        {[1, 2, 3, 4, 5].map((i) => (
          <svg
            key={i}
            viewBox="0 0 24 24"
            className={`h-4 w-4 ${
              i <= Math.round(gennemsnit) ? "fill-brand text-brand" : "fill-neutral-200 text-neutral-200"
            }`}
          >
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        ))}
      </div>
      <span className="text-sm text-neutral-500">
        {antal > 0 ? `${gennemsnit.toFixed(1)} (${antal} bedømmelser)` : "Ingen bedømmelser endnu"}
      </span>
    </div>
  );
}
