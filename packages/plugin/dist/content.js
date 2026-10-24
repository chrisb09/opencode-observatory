import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./scrub.js";
/** Tool I/O is capped head+tail so diagnostics survive without shipping logs. */
export const TOOL_OUTPUT_LIMIT = 8192;
const MAX_LOCAL_MEDIA_BYTES = 32 * 1024 * 1024;
export function hashText(text) {
    return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
export function hashBytes(bytes) {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
export function truncateText(value, limit = TOOL_OUTPUT_LIMIT) {
    const originalBytes = Buffer.byteLength(value, "utf8");
    if (originalBytes <= limit)
        return { text: value, truncated: false, originalBytes };
    const half = Math.floor(limit / 2);
    const head = value.slice(0, half);
    const tail = value.slice(-half);
    return {
        text: `${head}\n…[truncated ${originalBytes - Buffer.byteLength(head + tail, "utf8")} bytes]…\n${tail}`,
        truncated: true,
        originalBytes,
    };
}
function dimensions(bytes) {
    if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes.length >= 10 && bytes.subarray(0, 3).toString("ascii") === "GIF") {
        return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (bytes.length >= 30 && bytes.subarray(12, 16).toString("ascii") === "WEBP") {
        if (bytes.subarray(16, 20).toString("ascii") === "VP8X") {
            const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
            const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
            return { width, height };
        }
    }
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) {
                offset += 1;
                continue;
            }
            const marker = bytes[offset + 1];
            if (marker === 0xd8 || marker === 0xd9) {
                offset += 2;
                continue;
            }
            const length = bytes.readUInt16BE(offset + 2);
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
            }
            offset += 2 + length;
        }
    }
    return null;
}
function mediaOf(contentHash, mime, bytes, filename, availability, imageBytes) {
    const size = imageBytes ? dimensions(imageBytes) : null;
    return {
        contentHash,
        mime,
        bytes,
        width: size?.width ?? null,
        height: size?.height ?? null,
        filename,
        availability,
    };
}
/**
 * Describe a URL without uploading the payload. Inline and accessible local
 * files are hashed from their actual bytes; deleted files and remote URLs fall
 * back to a URL hash and an explicit availability marker.
 */
export function mediaFromUrl(url, options = {}) {
    const hintedMime = options.mime;
    const mime = hintedMime ?? "application/octet-stream";
    const filename = options.filename ?? null;
    if (url.startsWith("data:")) {
        const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
        if (!match)
            return null;
        try {
            const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
            const declared = match[1] || "application/octet-stream";
            return mediaOf(hashBytes(bytes), hintedMime ?? declared, bytes.length, filename, "inline", bytes);
        }
        catch {
            return null;
        }
    }
    if (url.startsWith("file:")) {
        try {
            const path = fileURLToPath(url);
            const stat = statSync(path);
            if (stat.size <= MAX_LOCAL_MEDIA_BYTES) {
                const bytes = readFileSync(path);
                return mediaOf(hashBytes(bytes), mime, stat.size, filename ?? basename(path), "local", bytes);
            }
            return mediaOf(hashText(url), mime, stat.size, filename ?? basename(path), "local");
        }
        catch {
            return mediaOf(hashText(url), mime, null, filename, "local_missing");
        }
    }
    if (/^https?:\/\//i.test(url)) {
        return mediaOf(hashText(url), mime, null, filename, options.source === "tool" ? "tool" : "remote");
    }
    return null;
}
export function mediaFromPart(part) {
    const url = part?.url ?? part?.uri;
    if (typeof url !== "string" || !url)
        return null;
    return mediaFromUrl(url, {
        mime: typeof part.mime === "string" ? part.mime : undefined,
        filename: typeof part.filename === "string" ? part.filename : typeof part.name === "string" ? part.name : null,
        ...(part?.attachments || part?.tool ? { source: "tool" } : {}),
    });
}
export function mediaMarker(media) {
    const size = media.bytes === null || media.bytes === undefined ? "size unknown" : `${media.bytes} bytes`;
    return `[media ${media.mime}${media.filename ? ` ${media.filename}` : ""} · ${size} · ${media.contentHash}]`;
}
export function makeContentPart(input) {
    const original = input.text ?? "";
    const redacted = redactSecrets(original);
    const tool = input.kind === "tool_input" || input.kind === "tool_output";
    const capped = truncateText(redacted.text, tool ? TOOL_OUTPUT_LIMIT : 1_000_000);
    const media = input.media
        ? {
            ...input.media,
            description: input.media.description ? redactSecrets(input.media.description).text : input.media.description,
            extractedText: input.media.extractedText ? redactSecrets(input.media.extractedText).text : input.media.extractedText,
        }
        : null;
    return {
        installationId: input.installationId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        partId: input.partId,
        kind: input.kind,
        role: input.role,
        text: capped.text,
        contentHash: hashText(capped.text),
        truncated: capped.truncated,
        originalBytes: capped.originalBytes,
        observedAt: input.observedAt,
        ...(media ? { media } : {}),
    };
}
//# sourceMappingURL=content.js.map