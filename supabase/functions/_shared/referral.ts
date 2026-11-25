// E6 (indicação): leitura determinística das respostas do lead.

const strip = (value: string) => String(value || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase();

const NON_NAME_WORDS = new Set([
  'sim', 'nao', 'tenho', 'tem', 'temos', 'um', 'uma', 'uns', 'umas', 'o', 'a', 'os', 'as', 'meu', 'minha', 'meus', 'minhas',
  'amigo', 'amiga', 'amigos', 'amigas', 'irma', 'irmao', 'irmas', 'irmaos', 'prima', 'primo', 'mae', 'pai', 'esposa', 'esposo',
  'marido', 'filho', 'filha', 'colega', 'colegas', 'vizinho', 'vizinha', 'tia', 'tio', 'sobrinho', 'sobrinha', 'cunhado', 'cunhada',
  'namorado', 'namorada', 'sogra', 'sogro', 'conhecido', 'conhecida', 'pessoa', 'alguem', 'que', 'quer', 'querem', 'queria',
  'tambem', 'pode', 'ser', 'claro', 'com', 'certeza', 'ela', 'ele', 'dela', 'dele', 'se', 'chama', 'chamada', 'chamado', 'nome',
  'e', 'eh', 'de', 'da', 'do', 'das', 'dos', 'pra', 'para', 'fazer', 'faculdade', 'graduacao', 'curso', 'estudar', 'interesse',
  'interessada', 'interessado', 'opa', 'oi', 'ok', 'beleza', 'blz', 'perfeito', 'acho', 'creio', 'talvez', 'sei', 'la', 'aqui',
  'trabalho', 'casa', 'mesmo', 'mesma', 'ai', 'entao', 'tipo', 'boa', 'bom', 'legal', 'obrigado', 'obrigada', 'valeu', 'agora',
  'momento', 'ninguem', 'nenhum', 'nenhuma', 'ja', 'esta', 'ta', 'vou', 'te', 'passar', 'mandar', 'numero', 'telefone', 'contato',
]);

export function looksLikeReferralPhone(message: string): boolean {
  const digits = String(message || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 13;
}

export function referralPhoneFrom(message: string): string {
  const match = String(message || '').match(/\+?\d[\d\s().-]{8,}\d/);
  return match ? match[0].trim() : String(message || '').trim();
}

export function userDeclinesReferral(message: string): boolean {
  const n = strip(message).replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n || looksLikeReferralPhone(message)) return false;
  if (/^(nao|n|nop|nope|negativo|nenhum|nenhuma|ninguem)\b/.test(n)) return true;
  return /(nao tenho|nao conheco|nao lembro|nao sei de ninguem|ninguem|sem indicac|agora nao|no momento nao|nao no momento|por enquanto nao|deixa pra la|deixa para la|fica pra proxima|fica para proxima|nenhum amigo|nenhuma pessoa)/.test(n);
}

/** Extrai o nome de quem está sendo indicado ("Sim, a Maria", "Pedro Alves", "minha irmã Ana"). */
export function extractReferralName(message: string): string | null {
  const raw = String(message || '').replace(/\+?\d[\d\s().-]{6,}\d/g, ' ').replace(/[^\p{L}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const words = raw.split(' ').filter(Boolean);
  const candidates = words.filter((word) => !NON_NAME_WORDS.has(strip(word)) && strip(word).length >= 2);
  if (candidates.length === 0) return null;
  const allWordsAreName = candidates.length === words.length;
  const capitalized = candidates.filter((word) => /^\p{Lu}/u.test(word));
  const picked = capitalized.length > 0 ? capitalized : (allWordsAreName && words.length <= 4 ? candidates : []);
  if (picked.length === 0 || picked.length > 4) return null;
  return picked.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
