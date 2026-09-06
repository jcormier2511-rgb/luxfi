/** Linear-interpolation percentile (same convention as numpy's default / Excel PERCENTILE.INC)
 *  over an ALREADY-SORTED ascending array. Shared by every price aggregation that needs a
 *  quartile — Market Guide's IQR outlier filter and Market Pulse/Briefing's average, below. */
export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedAsc[base + 1];
  return next === undefined ? sortedAsc[base] : sortedAsc[base] + rest * (next - sortedAsc[base]);
}

/**
 * IQR outlier filtering (same spec-mandated deterministic method Market Guide already uses,
 * never an LLM judgment call): Q1/Q3 over the sample, bounds at 1.5x IQR beyond each quartile.
 * Only meaningful for a sample of 5 or more (see callers) — with fewer points a quartile sits so
 * close to the data's own extremes that "outlier" stops meaning anything.
 */
export function excludeOutliers(amounts: number[]): { clean: number[]; excludedCount: number } {
  const sorted = [...amounts].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;
  const clean = amounts.filter((a) => a >= lowerBound && a <= upperBound);
  return { clean, excludedCount: amounts.length - clean.length };
}
