// Antigravity is routed through OpenCode's Google provider, but is a distinct service.
export function providerGroup(provider: string, model: string) {
  return provider === "google" && model.startsWith("antigravity-") ? "antigravity" : provider;
}
