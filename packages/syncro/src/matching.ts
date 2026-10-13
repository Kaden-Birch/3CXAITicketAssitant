export function normalizeClinic(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
function similarity(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = old;
    }
  }
  const editScore = 1 - row[b.length] / Math.max(a.length, b.length);
  const at = a.split(" "),
    bt = b.split(" ");
  // Allow a single extra word, e.g. Horizon Dental -> Horizon Family Dental.
  const expansion =
    at.length >= 2 &&
    bt.length === at.length + 1 &&
    at.every((t) => bt.includes(t))
      ? 0.9
      : 0;
  return Math.max(editScore, expansion);
}
export function selectClinic(
  query: string,
  candidates: { id: string; name: string }[],
): { id: string; name: string } | null {
  const normalized = normalizeClinic(query);
  if (normalized.length < 5 || normalized.length > 150) return null;
  const ranked = candidates
    .filter((c) => c.name && c.name.length <= 150)
    .map((c) => ({
      ...c,
      score: similarity(normalized, normalizeClinic(c.name)),
    }))
    .filter((c) => c.score >= 0.86)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked[1] && ranked[0].score - ranked[1].score < 0.08))
    return null;
  return { id: ranked[0].id, name: ranked[0].name };
}
