import { providerGroup } from "@observatory/contracts";

export type ChartGroup = { id: string; label: string; provider?: string | null };
const providerHues: Record<string, number> = Object.assign(Object.create(null), { openai: 145, google: 215, antigravity: 275, anthropic: 45, oneprovider: 20, "opencode-go": 185, zai: 335 });
function hash(id: string) {
  let value = 2166136261;
  for (const char of id) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return value;
}
export function providerColor(provider: string) {
  return `hsl(${providerHues[provider] ?? hash(provider) % 360} 72% var(--model-lightness))`;
}
export function modelColor(id: string) {
  const [provider, ...model] = id.split("/");
  const family = providerGroup(provider!, model.join("/"));
  const value = hash(id);
  return `hsl(${(providerHues[family] ?? hash(family) % 360) + value % 15 - 7} ${60 + value % 25}% calc(var(--model-lightness) + ${value % 25 - 12}%))`;
}
export function groupColors(groups: ChartGroup[], grouping: string, modelUniverse: ChartGroup[] = groups) {
  if (!["model", "provider"].includes(grouping)) return Object.fromEntries(groups.map(group => [group.id, `hsl(${hash(group.id) % 360} 72% var(--model-lightness))`]));
  const providers = [...new Set(modelUniverse.map(g => g.provider ?? g.id.split("/")[0]!))].sort();
  const hues = new Map(providers.filter(p => p in providerHues).map(p => [p, providerHues[p]!]));
  const distance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  // Custom providers take the largest remaining hue gap, rather than colliding by hash.
  for (const provider of providers.filter(p => !(p in providerHues))) {
    const preferred = hash(provider) % 360;
    let best = preferred, separation = -1;
    for (let offset = 0; offset < 360; offset++) {
      const candidate = (preferred + offset) % 360;
      const gap = hues.size ? Math.min(...[...hues.values()].map(hue => distance(hue, candidate))) : 360;
      if (gap > separation) { best = candidate; separation = gap; }
    }
    hues.set(provider, best);
  }
  const families = new Map<string, string[]>();
  if (grouping === "model") for (const group of modelUniverse) {
    const family = group.provider ?? group.id.split("/")[0]!;
    if (!families.has(family)) families.set(family, []);
    if (!families.get(family)!.includes(group.id)) families.get(family)!.push(group.id);
  }
  for (const ids of families.values()) ids.sort();
  return Object.fromEntries(groups.map(group => {
    if (grouping === "provider") return [group.id, `hsl(${hues.get(group.id) ?? hash(group.id) % 360} 72% var(--model-lightness))`];
    const provider = group.provider ?? group.id.split("/")[0]!, siblings = families.get(provider) ?? [group.id], index = siblings.indexOf(group.id);
    // Alternate light/dark shades before filling intermediate shades, maximizing contrast.
    const position = index % 2 === 0 ? Math.floor(index / 2) : siblings.length - 1 - Math.floor(index / 2);
    const fraction = siblings.length > 1 ? position / (siblings.length - 1) : .5;
    return [group.id, `hsl(${(hues.get(provider) ?? hash(provider) % 360) + Math.round(fraction * 12 - 6)} ${Math.round(85 - fraction * 25)}% calc(var(--model-lightness) + ${Math.round(fraction * 26 - 13)}%))`];
  }));
}
