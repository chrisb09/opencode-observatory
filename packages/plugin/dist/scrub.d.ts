/**
 * Content leaves the machine only through an explicit opt-in (`contentMode`).
 * These rules run before anything enters the outbox. They deliberately target
 * credential shapes rather than arbitrary high-entropy words, so normal prose
 * and code are not mangled.
 */
export declare function redactSecrets(input: string): {
    text: string;
    redactions: number;
};
