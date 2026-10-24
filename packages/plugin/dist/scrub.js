/**
 * Content leaves the machine only through an explicit opt-in (`contentMode`).
 * These rules run before anything enters the outbox. They deliberately target
 * credential shapes rather than arbitrary high-entropy words, so normal prose
 * and code are not mangled.
 */
const RULES = [
    { pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/g, replacement: "$1 [REDACTED]" },
    { pattern: /\b(Basic)\s+[A-Za-z0-9+/=]{12,}/g, replacement: "$1 [REDACTED]" },
    { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: "sk-[REDACTED]" },
    { pattern: /\bxai-[A-Za-z0-9]{20,}\b/g, replacement: "xai-[REDACTED]" },
    { pattern: /\bobs_[A-Za-z0-9_-]{16,}\b/g, replacement: "obs_[REDACTED]" },
    { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: "gh*_[REDACTED]" },
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: "github_pat_[REDACTED]" },
    { pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, replacement: "glpat-[REDACTED]" },
    { pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, replacement: "xox*_[REDACTED]" },
    { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "AKIA[REDACTED]" },
    { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replacement: "AIza[REDACTED]" },
    { pattern: /\bhf_[A-Za-z0-9]{20,}\b/g, replacement: "hf_[REDACTED]" },
    { pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g, replacement: "npm_[REDACTED]" },
    { pattern: /\bpypi-[A-Za-z0-9_-]{20,}\b/g, replacement: "pypi-[REDACTED]" },
    {
        pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
        replacement: "[REDACTED PRIVATE KEY]",
    },
    {
        // KEY=value, TOKEN: value, PASSWORD=... in .env files and shell exports.
        pattern: /(^|\n)([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)[A-Za-z0-9_]*)\s*[:=]\s*["']?([^\s"'#]{8,})["']?/gi,
        replacement: (_match, prefix, name) => `${prefix}${name}=[REDACTED]`,
    },
    {
        pattern: /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)"\s*:\s*")[^"]{8,}(")/gi,
        replacement: "$1[REDACTED]$2",
    },
    {
        pattern: /([?&](?:token|key|api_key|apikey|access_token|secret|password)=)[^&\s]{8,}/gi,
        replacement: "$1[REDACTED]",
    },
];
export function redactSecrets(input) {
    let text = input;
    let redactions = 0;
    for (const rule of RULES) {
        if (typeof rule.replacement === "string") {
            const before = text;
            text = text.replace(rule.pattern, rule.replacement);
            if (text !== before)
                redactions += 1;
        }
        else {
            text = text.replace(rule.pattern, (...args) => {
                redactions += 1;
                return rule.replacement(...args);
            });
        }
    }
    return { text, redactions };
}
//# sourceMappingURL=scrub.js.map