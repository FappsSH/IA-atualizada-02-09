// Perguntas acadêmicas sem dado no catálogo (spec do administrador, 24/11/2026).
// Horas de estágio: a AgentHub promete buscar no setor acadêmico, o admin responde
// junto com a confirmação da proposta e a AgentHub repassa na retomada.

export const INTERNSHIP_HOURS_REPLY = 'A quantidade de horas exatas eu vou solicitar pro setor acadêmico e te envio assim que receber, tudo bem?';

const strip = (v: string) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function asksInternshipHours(message: string): boolean {
  const n = strip(message);
  if (!/estagio/.test(n)) return false;
  return /(hora|carga horaria|quanto tempo|quantos? (meses|dias|semestres)|duracao|dura quanto|tempo de estagio|quanto dura)/.test(n);
}

export function isShortAcknowledgement(message: string): boolean {
  const n = strip(message).replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(ok|okay|ta|ta bom|ta bem|tudo bem|tudo certo|certo|beleza|blz|pode ser|sim|claro|combinado|fechado|perfeito|otimo|show|joia|aguardo|fico no aguardo|obrigad[oa]|valeu)( obrigad[oa]| sim| entao)?$/.test(n);
}

/** Lê as horas na mensagem do administrador ("Estágio: 400 horas", "400h"). */
export function extractInternshipHours(adminText: string): string | null {
  const match = String(adminText || '').match(/(\d{2,4}(?:[.,]\d+)?)\s*(?:h\b|hs\b|hrs?\b|horas?\b)/i);
  return match ? `${match[1]} horas` : null;
}

// Provas (decisão do administrador, 25/11/2026).
export function asksAboutExams(message: string): boolean {
  const n = strip(message);
  return /\b(prova|provas|avaliacao|avaliacoes|exame|exames)\b/.test(n);
}

export function buildExamsReply(modality: string, firstName?: string | null): string {
  const m = strip(modality);
  const name = String(firstName || '').trim();
  if (m.includes('semi')) {
    return `Nos primeiros semestres, as provas são feitas pela plataforma${name ? `, ${name}` : ''}.\n\n`
      + 'E não precisa se preocupar: quando chegar essa época, os tutores vão estar acompanhando de pertinho pra te ajudar da melhor forma.';
  }
  return `Todas as provas são feitas pela plataforma${name ? `, ${name}` : ''}, sem precisar ir até o polo.\n\n`
    + 'Ou seja, você não vai ter nenhum custo de deslocamento com isso.';
}
