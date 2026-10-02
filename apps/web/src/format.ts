export const money = (value: unknown) => value == null ? "—" : Intl.NumberFormat("en", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
export const chartTooltipStyle = { background: "var(--tooltip-bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8 };
