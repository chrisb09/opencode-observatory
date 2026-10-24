import type { ContentPart, Media } from "@observatory/contracts";
export type ContentKind = ContentPart["kind"];
export type ContentRole = NonNullable<ContentPart["role"]>;
/** Tool I/O is capped head+tail so diagnostics survive without shipping logs. */
export declare const TOOL_OUTPUT_LIMIT = 8192;
export declare function hashText(text: string): string;
export declare function hashBytes(bytes: Buffer): string;
export declare function truncateText(value: string, limit?: number): {
    text: string;
    truncated: boolean;
    originalBytes: number;
};
/**
 * Describe a URL without uploading the payload. Inline and accessible local
 * files are hashed from their actual bytes; deleted files and remote URLs fall
 * back to a URL hash and an explicit availability marker.
 */
export declare function mediaFromUrl(url: string, options?: {
    mime?: string;
    filename?: string | null;
    source?: "tool";
}): Media | null;
export declare function mediaFromPart(part: any): Media | null;
export declare function mediaMarker(media: Media): string;
export interface ContentInput {
    installationId: string;
    sessionId: string;
    messageId: string;
    partId: string;
    kind: ContentKind;
    role: ContentRole;
    text: string;
    observedAt: number;
    media?: Media | null;
}
export declare function makeContentPart(input: ContentInput): ContentPart;
