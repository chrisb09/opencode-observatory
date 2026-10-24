import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../packages/plugin/src/scrub.js";
import { makeContentPart, mediaFromUrl, truncateText, hashText } from "../packages/plugin/src/content.js";
import { Outbox } from "../packages/plugin/src/outbox.js";
import { config, event } from "./fixtures.js";
import type { ContentPart } from "@observatory/contracts";

describe("content and privacy", () => {
  test("redactSecrets removes secrets and leaves ordinary prose intact", () => {
    const prose = "Hello world, this is normal documentation and prose with nothing secret.";
    expect(redactSecrets(prose)).toEqual({ text: prose, redactions: 0 });

    const pemKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3v7X5V5q8Z1b8hK...
-----END RSA PRIVATE KEY-----`;

    const secrets = [
      "sk-1234567890abcdef12345678",
      "obs_1234567890abcdef12345678",
      "ghp_1234567890abcdef12345678901234",
      "AKIAIOSFODNN7EXAMPLE",
      "Authorization: Bearer secret_token_1234567890",
      "Authorization: Basic dXNlcjpwYXNzd29yZA==",
      "xai-1234567890abcdef12345678",
      pemKey,
      "API_KEY=super_secret_env_value_12345",
      '{"apiKey":"super_secret_json_key_value"}',
      "https://example.com/api?token=super_secret_query_value",
    ];

    const input = secrets.join("\n");
    const result = redactSecrets(input);

    expect(result.redactions).toBeGreaterThanOrEqual(secrets.length);
    for (const secret of secrets) {
      expect(result.text).not.toContain(secret);
    }

    expect(result.text).toContain("sk-[REDACTED]");
    expect(result.text).toContain("obs_[REDACTED]");
    expect(result.text).toContain("gh*_[REDACTED]");
    expect(result.text).toContain("AKIA[REDACTED]");
    expect(result.text).toContain("Bearer [REDACTED]");
    expect(result.text).toContain("Basic [REDACTED]");
    expect(result.text).toContain("xai-[REDACTED]");
    expect(result.text).toContain("[REDACTED PRIVATE KEY]");
    expect(result.text).toContain("API_KEY=[REDACTED]");
    expect(result.text).toContain('"apiKey":"[REDACTED]"');
    expect(result.text).toContain("?token=[REDACTED]");
  });

  test("truncateText and makeContentPart handle tool output vs assistant response", () => {
    const shortText = "x".repeat(100);
    const shortResult = truncateText(shortText);
    expect(shortResult).toEqual({ text: shortText, truncated: false, originalBytes: 100 });

    const longText = "H".repeat(10000) + "T".repeat(10000); // 20,000 bytes
    const toolPart = makeContentPart({
      installationId: "inst_1",
      sessionId: "ses_1",
      messageId: "msg_1",
      partId: "part_1",
      kind: "tool_output",
      role: "tool",
      text: longText,
      observedAt: 1700000000000,
    });

    expect(toolPart.truncated).toBe(true);
    expect(toolPart.originalBytes).toBe(20000);
    expect(toolPart.text.startsWith("H".repeat(4096))).toBe(true);
    expect(toolPart.text.endsWith("T".repeat(4096))).toBe(true);
    expect(toolPart.text).toContain("…[truncated 11808 bytes]…");
    expect(toolPart.contentHash.startsWith("sha256:")).toBe(true);
    expect(toolPart.contentHash).toBe(hashText(toolPart.text));

    const assistantPart = makeContentPart({
      installationId: "inst_1",
      sessionId: "ses_1",
      messageId: "msg_1",
      partId: "part_2",
      kind: "response",
      role: "assistant",
      text: longText,
      observedAt: 1700000000000,
    });

    expect(assistantPart.truncated).toBe(false);
    expect(assistantPart.originalBytes).toBe(20000);
    expect(assistantPart.text).toBe(longText);
  });

  test("mediaFromUrl parses inline data URLs, missing local paths, and remote URLs", () => {
    // 1x1 valid PNG in base64:
    // 8-byte signature + IHDR chunk (13 bytes: 1x1, 8-bit depth, RGB) + IDAT + IEND
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==";
    const inline = mediaFromUrl(`data:image/png;base64,${pngBase64}`);
    expect(inline).not.toBeNull();
    expect(inline?.availability).toBe("inline");
    expect(inline?.mime).toBe("image/png");
    expect(inline?.width).toBe(1);
    expect(inline?.height).toBe(1);
    expect(inline?.contentHash.startsWith("sha256:")).toBe(true);

    const missing = mediaFromUrl("file:///tmp/nonexistent-observatory-test-file.png");
    expect(missing).not.toBeNull();
    expect(missing?.availability).toBe("local_missing");

    const remote = mediaFromUrl("https://example.test/x.png");
    expect(remote).not.toBeNull();
    expect(remote?.availability).toBe("remote");
  });

  test("Outbox enqueues, acknowledges, updates, replays, and drains content parts", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "obs-test-"));
    const dbPath = join(tmp, "outbox.db");
    const postedContent: any[] = [];
    const postedEvents: any[] = [];

    const mockFetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(init?.body as string);
      if (url.endsWith("/api/content")) {
        postedContent.push(body);
        return new Response(JSON.stringify({ accepted: body.parts.length }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/api/ingest")) {
        postedEvents.push(body);
        return new Response(JSON.stringify({ acknowledged: body.events.map((e: any) => e.eventId) }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const outbox = new Outbox(config, dbPath, mockFetcher);

    try {
      const part1: ContentPart = {
        installationId: config.installationId,
        sessionId: "ses_1",
        messageId: "msg_1",
        partId: "part_1",
        kind: "prompt",
        role: "user",
        text: "first version",
        contentHash: hashText("first version"),
        truncated: false,
        originalBytes: 13,
        observedAt: 1700000000000,
      };

      outbox.enqueueContent(part1);
      expect(outbox.health().pendingContent).toBe(1);

      const flushed = await outbox.flushContent();
      expect(flushed).toBe(1);
      expect(outbox.health().pendingContent).toBe(0);
      expect(postedContent.length).toBe(1);
      expect(postedContent[0].parts).toHaveLength(1);
      expect(postedContent[0].parts[0].text).toBe("first version");

      // Re-enqueuing the same acknowledged part keeps it acknowledged
      outbox.enqueueContent(part1);
      expect(outbox.health().pendingContent).toBe(0);

      // Changing part text and re-enqueuing makes it pending again
      const part1Modified: ContentPart = {
        ...part1,
        text: "second version",
        contentHash: hashText("second version"),
        originalBytes: 14,
      };
      outbox.enqueueContent(part1Modified);
      expect(outbox.health().pendingContent).toBe(1);

      // Replay() makes it pending again
      await outbox.flushContent();
      expect(outbox.health().pendingContent).toBe(0);
      outbox.replay();
      expect(outbox.health().pendingContent).toBe(1);

      // Drain() drains both one metadata event and one content part
      const metaEvent = event();
      outbox.enqueue(metaEvent);
      expect(outbox.health().pending).toBe(1);
      expect(outbox.health().pendingContent).toBe(1);

      const healthAfterDrain = await outbox.drain();
      expect(healthAfterDrain.pending).toBe(0);
      expect(healthAfterDrain.pendingContent).toBe(0);
    } finally {
      await outbox.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
