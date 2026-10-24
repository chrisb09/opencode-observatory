import type { FoldedClaim } from "./vault-model.js";

const CURATED_START = "<!-- vault:curated:start -->";
const CURATED_END = "<!-- vault:curated:end -->";

export interface ConceptDocument {
  concept: string;
  title?: string | null;
  claims: FoldedClaim[];
  /** Existing curated prose. Null or empty produces the default placeholder. */
  curated?: string | null;
}

const DEFAULT_CURATED =
  "<!-- Prose between these markers is preserved by the renderer. Generated claims are updated below. -->";

function inlineCode(value: string): string {
  return `\`${value.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;").replace(/`/g, "")}\``;
}

/** Keep untrusted text from closing the generated sentinel block. */
function safeText(value: string): string {
  return value
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function date(ms: number): string {
  const value = new Date(ms);
  return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : "unknown";
}

function titleFor(concept: string): string {
  const leaf = concept.split("/").filter(Boolean).pop() ?? concept;
  const words = leaf.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : concept;
}

export function conceptTitle(concept: string): string {
  return titleFor(concept);
}

export function extractCurated(markdown: string): string | null {
  const start = markdown.indexOf(CURATED_START);
  if (start < 0) return null;
  const end = markdown.indexOf(CURATED_END, start + CURATED_START.length);
  if (end < 0) return null;
  return markdown
    .slice(start + CURATED_START.length, end)
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

export function renderConcept(document: ConceptDocument): string {
  const claims = [...document.claims].sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.subject.localeCompare(b.subject) ||
      a.validFrom - b.validFrom ||
      a.key.localeCompare(b.key),
  );
  const scopes = [...new Set(claims.map(claim => claim.scope))].sort();
  const active = claims.filter(claim => claim.status === "active");
  const disputed = claims.filter(claim => claim.status === "disputed");
  const hypotheses = claims.filter(claim => claim.status === "hypothesis");
  const history = claims.filter(claim => claim.status === "superseded");

  const lines: string[] = [
    "---",
    `concept: ${JSON.stringify(document.concept)}`,
    `title: ${JSON.stringify(document.title?.trim() || titleFor(document.concept))}`,
    `claims: ${claims.length}`,
    ...(scopes.length ? ["scopes:", ...scopes.map(scope => `  - ${JSON.stringify(scope)}`)] : ["scopes: []"]),
    "---",
    "",
    `# ${document.title?.trim() || titleFor(document.concept)}`,
    "",
    CURATED_START,
    document.curated?.trim() || DEFAULT_CURATED,
    CURATED_END,
    "",
  ];

  const block = (claim: FoldedClaim, trailing?: string) => {
    const header = [
      `**${claim.modality}**`,
      inlineCode(claim.scope),
      claim.evidenceTier,
      `valid ${date(claim.validFrom)} → ${claim.status === "superseded" && claim.validTo !== null ? date(claim.validTo) : "present"}`,
    ].join(" · ");
    lines.push(
      `<!-- claim:${claim.key} -->`,
      `### ${inlineCode(claim.subject)}`,
      "",
      header,
      "",
      safeText(claim.statement),
      "",
      `- evidence: ${claim.evidence.map(evidence => {
        const where = [evidence.sessionId, evidence.messageId, evidence.partId].filter(Boolean).map(value => inlineCode(value!)).join(" / ");
        const tool = evidence.tool ? ` · tool ${inlineCode(evidence.tool)}` : "";
        const url = evidence.url ? ` · ${evidence.url}` : "";
        return `${where}${tool}${url}`;
      }).join("; ")}`,
      ...(trailing ? ["", trailing] : []),
      `<!-- /claim:${claim.key} -->`,
      "",
    );
  };

  lines.push("## Active claims", "");
  if (!active.length) lines.push("No active claims recorded yet.", "");
  for (const scope of [...new Set(active.map(claim => claim.scope))].sort()) {
    lines.push(`### Scope ${inlineCode(scope)}`, "");
    for (const claim of active.filter(value => value.scope === scope)) block(claim);
  }

  if (disputed.length) {
    lines.push("## Disputed", "", "These claims conflict and are not treated as current truth.", "");
    for (const claim of disputed) block(claim);
  }
  if (hypotheses.length) {
    lines.push("## Hypotheses", "", "Provisional claims. They never supersede verified observations.", "");
    for (const claim of hypotheses) block(claim);
  }
  if (history.length) {
    lines.push("## History", "");
    for (const claim of history) {
      block(claim, `Superseded by ${inlineCode(claim.supersededBy ?? "unknown")} on ${date(claim.validTo ?? claim.validFrom)}.`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
