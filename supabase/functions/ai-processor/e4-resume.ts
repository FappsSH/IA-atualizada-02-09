// Retomada da proposta (texto aprovado pelo administrador em 25/11/2026).
//
// Prontinho [NOME]!! A proposta já está com você.
// Montei pensando exatamente no que você me contou, de [ligação curta com o objetivo].
// E fica à vontade pra mostrar pro seu marido também. Se ele tiver qualquer dúvida, pode me mandar por aqui.
//   (só quando a pessoa decide junto com alguém)
// Consegue me dar um retorno até o fim do dia pra gente garantir essa oportunidade? Ou já podemos garantir essa oportunidade agora?

export const E4_RESUME_QUESTIONS = 'Consegue me dar um retorno até o fim do dia pra gente garantir essa oportunidade? Ou já podemos garantir essa oportunidade agora?';

const strip = (v: string) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const MALE = new Set(['pai', 'marido', 'esposo', 'namorado', 'filho', 'sócio', 'socio', 'familiar']);
const FEMALE = new Set(['mãe', 'mae', 'esposa', 'namorada', 'filha', 'sócia', 'socia']);

export function buildMotivationLink(motivation: string, course: string): string {
  const m = strip(motivation);
  const curso = String(course || '').trim();
  const emCurso = curso ? ` em ${curso}` : '';
  if (!m) return curso ? `sobre o seu objetivo com a graduação em ${curso}` : 'sobre o seu objetivo com essa graduação';
  if (/(famil|seguir os passos|\b(pai|mae|irma|irmao|tio|tia|avo|avos)\b)/.test(m)) return `de seguir esse caminho da sua família${emCurso}`;
  if (/(cresc|promoc|promov|cargo|empresa)/.test(m)) return 'de crescer na empresa onde você trabalha';
  if (/(trabalh|atuo|atua|auxiliar|tecnic|ja sou|na pratica|profiss)/.test(m)) return `de você já trabalhar na área e querer ir além${emCurso}`;
  if (/(sonho|sempre quis|vontade|desde)/.test(m)) return `de realizar esse sonho de fazer ${curso || 'essa graduação'}`;
  return curso ? `sobre o seu objetivo com a graduação em ${curso}` : 'sobre o seu objetivo com essa graduação';
}

export function buildDeciderLine(participant: string | null | undefined): string | null {
  const p = String(participant || '').trim().toLowerCase();
  if (!p || p === 'self') return null;
  if (MALE.has(p)) return `E fica à vontade pra mostrar pro seu ${p} também. Se ele tiver qualquer dúvida, pode me mandar por aqui.`;
  if (FEMALE.has(p)) return `E fica à vontade pra mostrar pra sua ${p} também. Se ela tiver qualquer dúvida, pode me mandar por aqui.`;
  return 'E fica à vontade pra mostrar pra essa pessoa também. Se ela tiver qualquer dúvida, pode me mandar por aqui.';
}

export function buildE4ResumeMessages(params: { firstName?: string | null; motivation: string; course: string; decisionParticipant?: string | null }): string[] {
  const name = String(params.firstName || '').trim();
  const opening = `Prontinho${name ? ` ${name}` : ''}!! A proposta já está com você.\n\nMontei pensando exatamente no que você me contou, ${buildMotivationLink(params.motivation, params.course)}.`;
  const decider = buildDeciderLine(params.decisionParticipant);
  return [opening, ...(decider ? [decider] : []), E4_RESUME_QUESTIONS];
}
