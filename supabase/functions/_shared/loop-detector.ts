// Loop Detector — interrompe agente que repete mesma tool com mesmos args.
// deno-lint-ignore-file
// @ts-nocheck

export interface ToolCallRecord {
    name: string;
    argsHash: string;
}

export function hashArgs(args: unknown): string {
    return JSON.stringify(args ?? {});
}

export function detectLoop(history: ToolCallRecord[], threshold = 3): boolean {
    if (history.length < threshold) return false;
    const last = history.slice(-threshold);
    return last.every((c) => c.name === last[0].name && c.argsHash === last[0].argsHash);
}
