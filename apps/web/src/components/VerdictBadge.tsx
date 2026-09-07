/** Shared status/verdict pill used in tables and the results view. */
export default function VerdictBadge({
  status,
  verdict,
}: {
  status: string;
  verdict: string | null;
}) {
  if (status !== "Done") {
    return <span className="badge badge-pending">{status}</span>;
  }
  if (!verdict) return <span className="badge badge-pending">—</span>;

  const cls =
    verdict === "Accepted"
      ? "badge-ok"
      : verdict.startsWith("Not Run")
        ? "badge-demo"
        : "badge-bad";
  return <span className={`badge ${cls}`}>{verdict}</span>;
}
