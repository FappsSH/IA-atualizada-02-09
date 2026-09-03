// Confirmation Guard — ADR-0006 (adaptado para Fapps)
// Tools com side-effect comercial só executam após "sim" explícito do usuário
// no histórico recente (últimas 3 mensagens humanas).
//
// No projeto Fapps apenas `registrar_matricula` é guarded:
// é uma ação irreversível que não deve ser disparada por engano.
//
// deno-lint-ignore-file
// @ts-nocheck

export const GUARDED_TOOLS = new Set([
    'registrar_matricula',
]);

const AFFIRMATIVE =
    /\b(sim|pode|aceito|confirmo|ok|fechado|manda|envia|vamos|topo|quero|vai|bora|claro|com certeza|pode ser|isso mesmo|exato)\b/i;

export interface GuardContext {
    toolName: string;
    recentUserMessages: string[]; // últimas 2-3 mensagens do usuário
}

/**
 * Retorna true se a tool pode ser executada.
 * Tools não-guarded: sempre true.
 * Tools guarded: só true se houver afirmativa explícita nas últimas mensagens.
 */
export function passesGuard(ctx: GuardContext): boolean {
    if (!GUARDED_TOOLS.has(ctx.toolName)) return true;
    return ctx.recentUserMessages.slice(-3).some((m) => AFFIRMATIVE.test(m));
}

export function guardFailureMessage(toolName: string): string {
    return (
        `[guard] tool ${toolName} bloqueada — sem confirmação explícita do lead nas últimas mensagens. ` +
        `Peça confirmação antes de executar esta ação.`
    );
}
