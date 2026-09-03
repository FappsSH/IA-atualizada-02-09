// Deterministic catalog resolution for course queries.
// This path bypasses free-form subagent reasoning for catalog existence/listing.
// deno-lint-ignore-file
// @ts-nocheck

function normalize(text: string) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isMediaPlaceholderMessage(message: string) {
  const normalized = normalize(message);
  return [
    'audio',
    'audio transcrito',
    'audio sem transcricao',
    'imagem',
    'video',
    'documento',
    'figurinha',
  ].includes(normalized);
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function stripMd(value: string) {
  return (value || '')
    .replace(/^[-*+#>\d.\s]+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

function cleanFilename(filename: string) {
  return stripMd(
    String(filename || '')
      .replace(/\.(md|markdown|txt|pdf)$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function assistantAskedCity(history: Array<{ role?: string; content?: string }>) {
  const lastAssistant = [...(history || [])]
    .reverse()
    .find((item) => item?.role === 'assistant' && item?.content)?.content || '';
  const normalized = normalize(lastAssistant);
  if (!normalized) return false;

  return [
    'qual cidade',
    'de qual cidade',
    'me confirma de qual cidade',
    'voce e de qual cidade',
    'qual a sua cidade',
    'em que cidade',
    'onde voce mora',
  ].some((pattern) => normalized.includes(pattern));
}

function assistantAskedMotivation(history: Array<{ role?: string; content?: string }>) {
  const lastAssistant = [...(history || [])]
    .reverse()
    .find((item) => item?.role === 'assistant' && item?.content)?.content || '';
  const normalized = normalize(lastAssistant);
  if (!normalized) return false;

  return [
    'ja trabalha na area',
    'trabalha na area',
    'esse curso representa um sonho',
    'esse curso e mais um sonho',
    'objetivo pessoal',
    'objetivo profissional',
    'sempre foi um sonho',
  ].some((pattern) => normalized.includes(pattern));
}

function assistantAskedCourseLine(history: Array<{ role?: string; content?: string }>) {
  const lastAssistant = [...(history || [])]
    .reverse()
    .find((item) => item?.role === 'assistant' && item?.content)?.content || '';
  const normalized = normalize(lastAssistant);
  if (!normalized) return false;

  return [
    'qual linha',
    'bacharelado',
    'licenciatura',
    'duas linhas',
  ].some((pattern) => normalized.includes(pattern));
}

function isExplicitCourseLineReply(message: string) {
  const normalized = normalize(message);
  return normalized === 'bacharelado' || normalized === 'licenciatura';
}

function looksLikeCityReply(message: string) {
  const normalized = normalize(message);
  if (!normalized) return false;

  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  const knownDirectCities = new Set([
    'porto velho',
    'vilhena',
    'cacoal',
    'ji parana',
    'ariquemes',
  ]);

  const blockedPhrases = new Set([
    'na minha',
    'na minha area',
    'na area',
    'na mesma area',
    'ja trabalho',
    'eu ja trabalho',
    'trabalho na area',
    'trabalho nela',
  ]);
  if (blockedPhrases.has(normalized)) return false;

  if (
    normalized.startsWith('sou de ') ||
    normalized.startsWith('moro em ') ||
    normalized.startsWith('resido em ') ||
    normalized.startsWith('sou do ') ||
    normalized.startsWith('sou da ') ||
    knownDirectCities.has(normalized)
  ) {
    return true;
  }

  const blocked = new Set([
    'sim',
    'nao',
    'talvez',
    'oi',
    'ola',
    'bom dia',
    'boa tarde',
    'boa noite',
    'obrigado',
    'obrigada',
    'quero saber',
    'quero fazer',
    'tenho interesse',
    'curso',
    'cursos',
    'bacharelado',
    'licenciatura',
  ]);
  if (blocked.has(normalized)) return false;

  const hasContextWord = words.some((word) => [
    'minha',
    'meu',
    'area',
    'trabalho',
    'atuo',
    'sonho',
    'objetivo',
  ].includes(word));
  if (hasContextWord) return false;

  const hasCatalogVerb = words.some((word) => [
    'quero',
    'queria',
    'gostaria',
    'curso',
    'cursos',
    'tem',
    'saber',
    'fazer',
    'interesse',
    'valor',
    'bolsa',
    'modalidade',
    'duracao',
    'duração',
    'bacharelado',
    'licenciatura',
  ].includes(word));
  if (hasCatalogVerb) return false;

  if (words.length === 1) return false;

  return true;
}

function looksLikeMotivationReply(message: string) {
  const normalized = normalize(message);
  if (!normalized) return false;

  return [
    'sempre quis',
    'sempre quiz',
    'meu sonho',
    'e um sonho',
    'objetivo',
    'gosto da area',
    'quero crescer',
    'quero migrar',
    'recebi uma oportunidade',
    'ja trabalho',
    'trabalho na area',
  ].some((pattern) => normalized.includes(pattern));
}

function isReplyToNonCatalogQuestion(message: string, history: Array<{ role?: string; content?: string }>) {
  if (assistantAskedCity(history) && looksLikeCityReply(message)) return true;
  if (assistantAskedMotivation(history) && looksLikeMotivationReply(message)) return true;
  return false;
}

export function detectContextualReplyKind(message: string, history: Array<{ role?: string; content?: string }>) {
  if (assistantAskedCity(history) && looksLikeCityReply(message)) return 'city';
  if (assistantAskedMotivation(history) && looksLikeMotivationReply(message)) return 'motivation';
  return null;
}

function detectSpecificCourse(message: string, history: Array<{ role?: string; content?: string }>) {
  const raw = message.trim();
  const normalized = normalize(raw);
  if (!normalized) return null;
  if (isMediaPlaceholderMessage(raw)) return null;

  const patterns = [
    /\bcurso de ([\p{L}\p{N}\s-]+)$/iu,
    /\btem o curso de ([\p{L}\p{N}\s-]+)$/iu,
    /\btem ([\p{L}\p{N}\s-]{3,})$/iu,
    /\boferece ([\p{L}\p{N}\s-]{3,})$/iu,
    /\bpossui ([\p{L}\p{N}\s-]{3,})$/iu,
    /\bgostaria de saber se tem ([\p{L}\p{N}\s-]{3,})$/iu,
    /\bquero saber mais sobre ([\p{L}\p{N}\s-]+)$/iu,
    /\bquero saber sobre ([\p{L}\p{N}\s-]+)$/iu,
    /\bqueria saber mais sobre ([\p{L}\p{N}\s-]+)$/iu,
    /\bqueria saber sobre ([\p{L}\p{N}\s-]+)$/iu,
    /\bme fala mais sobre ([\p{L}\p{N}\s-]+)$/iu,
    /\bme fale mais sobre ([\p{L}\p{N}\s-]+)$/iu,
    /\btenho interesse em ([\p{L}\p{N}\s-]+)$/iu,
    /\bquero fazer ([\p{L}\p{N}\s-]+)$/iu,
    /\bestou pensando em ([\p{L}\p{N}\s-]+)$/iu,
    /\bquero informacoes de ([\p{L}\p{N}\s-]+)$/iu,
    /\bquero informacoes sobre ([\p{L}\p{N}\s-]+)$/iu,
    /\bqueria informacoes de ([\p{L}\p{N}\s-]+)$/iu,
    /\bqueria informacoes sobre ([\p{L}\p{N}\s-]+)$/iu,
    /\bqueria saber sobre ([\p{L}\p{N}\s-]+)$/iu,
    /\binformacoes de ([\p{L}\p{N}\s-]+)$/iu,
    /\binformacoes sobre ([\p{L}\p{N}\s-]+)$/iu,
  ];

  const sanitized = raw.replace(/[!?.,;:]+$/g, '').trim();
  for (const pattern of patterns) {
    const match = sanitized.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  if (normalized.startsWith('tem ') && normalized.split(' ').length <= 5) {
    return sanitized.replace(/^tem\s+/i, '').trim();
  }

  if (normalized.startsWith('quero ')) {
    const candidate = sanitized.replace(/^quero\s+/i, '').trim();
    const candidateNormalized = normalize(candidate);
    const blockedStarts = [
      'saber',
      'ver',
      'entender',
      'informacoes',
      'informação',
      'informacao',
      'valores',
      'valor',
      'bolsa',
      'ajuda',
      'atendimento',
    ];
    if (
      candidate &&
      candidateNormalized.split(' ').length <= 5 &&
      !blockedStarts.some((prefix) => candidateNormalized.startsWith(normalize(prefix)))
    ) {
      return candidate;
    }
  }

  if (isReplyToNonCatalogQuestion(sanitized, history)) {
    return null;
  }

  const standaloneBlocked = new Set([
    'oi',
    'ola',
    'bom dia',
    'boa tarde',
    'boa noite',
    'tudo bem',
    'obrigado',
    'obrigada',
    'sim',
    'nao',
    'talvez',
    'quero saber',
    'tenho interesse',
    'quero fazer',
    'estou pensando',
    'informacoes',
    'informacao',
    'curso',
    'cursos',
    'sou',
    'moro',
    'cidade',
    'como funciona',
    'como e',
    'como é',
    'qual valor',
    'quais valores',
    'quanto custa',
    'quanto e',
    'quanto é',
    'tem bolsa',
    'qual a duracao',
    'qual a duração',
    'quanto tempo dura',
    'como funciona o curso',
    'me fala mais',
    'quero saber mais',
    'informacoes sobre valores',
    'porto velho',
    'vilhena',
    'cacoal',
    'ji parana',
    'ariquemes',
  ]);

  const standaloneNormalized = normalize(sanitized);
  const standaloneWords = standaloneNormalized.split(' ').filter(Boolean);
  const standaloneHasConversationVerbs = standaloneWords.some((word) => [
    'sou',
    'moro',
    'estou',
    'tenho',
    'quero',
    'queria',
    'gostaria',
    'vim',
    'preciso',
    'busco',
    'como',
    'funciona',
  ].includes(word));
  const standaloneHasConnectorWords = standaloneWords.some((word) => [
    'de',
    'do',
    'da',
    'em',
    'no',
    'na',
    'para',
    'pra',
  ].includes(word));
  if (
    standaloneWords.length >= 1 &&
    standaloneWords.length <= 2 &&
    !standaloneBlocked.has(standaloneNormalized) &&
    !standaloneHasConversationVerbs &&
    !standaloneHasConnectorWords &&
    !detectBrowseIntent(sanitized) &&
    !isBroadGenericCatalogQuestion(sanitized)
  ) {
    return sanitized;
  }

  return null;
}

function detectBrowseIntent(message: string) {
  const normalized = normalize(message);
  const patterns = [
    'quais cursos',
    'que cursos',
    'cursos que voces tem',
    'cursos que voce tem',
    'cursos voces tem',
    'cursos voce tem',
    'cursos tem',
    'na area',
    'area de',
    'area da',
    'area do',
    'outra area',
    'por area',
    'por modalidade',
    'por duracao',
    'por grau',
    'cursos ead',
    'cursos semipresencial',
    'cursos presenciais',
    'bacharelado',
    'licenciatura',
    'tecnologo',
    'tecnico',
    'tecnologia',
    'saude',
    'juridica',
    'gestao',
    'negocios',
    'educacao',
    'outras opcoes dessa area',
    'outras opcoes da area',
    'outras opcoes dessa mesma area',
    'mostrar outras opcoes',
    'me mostrar outras opcoes',
    'pode me mostrar outras opcoes',
    'opcoes dessa area',
  ];

  return patterns.some((pattern) => normalized.includes(pattern));
}

export function detectCatalogIntent(message: string) {
  return detectCatalogIntentWithHistory(message, []);
}

function isBroadGenericCatalogQuestion(message: string) {
  const normalized = normalize(message);
  const patterns = [
    'quais opcoes',
    'quais opcoes tem',
    'quais graduacoes',
    'quais graduacoes voces oferecem',
    'quais graduacoes voce oferece',
    'quero ver os cursos',
    'estou procurando uma graduacao',
    'quais cursos',
    'que cursos',
    'cursos que voces tem',
    'cursos que voce tem',
    'cursos voces tem',
    'cursos voce tem',
    'cursos tem',
  ];
  return patterns.some((pattern) => normalized.includes(pattern));
}

function assistantAskedAreaOrCourse(history: Array<{ role?: string; content?: string }>) {
  const lastAssistant = [...(history || [])]
    .reverse()
    .find((item) => item?.role === 'assistant' && item?.content)?.content || '';

  const normalized = normalize(lastAssistant);
  if (!normalized) return false;

  return [
    'qual area',
    'que area',
    'me diga a area',
    'me fala a area',
    'qual curso',
    'que curso',
    'curso voce procura',
    'curso voce busca',
  ].some((pattern) => normalized.includes(pattern));
}

function isShortCatalogFollowup(message: string, history: Array<{ role?: string; content?: string }>) {
  const normalized = normalize(message);
  if (!normalized) return false;
  if (!assistantAskedAreaOrCourse(history)) return false;
  return normalized.split(' ').length <= 4;
}

export function detectCatalogIntentWithHistory(message: string, history: Array<{ role?: string; content?: string }>) {
  if (isMediaPlaceholderMessage(message)) {
    return {
      matched: false,
      mode: null,
      query: '',
      rawQuery: message,
    };
  }

  if (detectContextualReplyKind(message, history)) {
    return {
      matched: false,
      mode: null,
      query: '',
      rawQuery: message,
    };
  }

  if (assistantAskedCourseLine(history) && isExplicitCourseLineReply(message)) {
    return {
      matched: false,
      mode: null,
      query: '',
      rawQuery: message,
    };
  }

  const specific = detectSpecificCourse(message, history);
  if (specific) {
    return {
      matched: true,
      mode: 'specific' as const,
      query: specific,
      rawQuery: message,
    };
  }

  if (isBroadGenericCatalogQuestion(message)) {
    return {
      matched: true,
      mode: 'browse_catalog' as const,
      query: message.trim(),
      rawQuery: message,
    };
  }

  if (isShortCatalogFollowup(message, history)) {
    return {
      matched: true,
      mode: 'specific_or_related' as const,
      query: message.trim(),
      rawQuery: message,
    };
  }

  if (detectBrowseIntent(message)) {
    return {
      matched: true,
      mode: 'browse' as const,
      query: message.trim(),
      rawQuery: message,
    };
  }

  return {
    matched: false,
    mode: null,
    query: '',
    rawQuery: message,
  };
}

function resultMentionsQuery(result: any, query: string) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return false;

  const haystack = normalize([
    result.filename,
    result.content,
  ].filter(Boolean).join(' '));

  if (haystack.includes(normalizedQuery)) return true;

  const tokens = normalizedQuery.split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function extractCourseLikeLines(results: any[]) {
  const blocked = [
    'universidade',
    'cruzeiro',
    'catalogo',
    'categoria',
    'area',
    'modalidade',
    'duracao',
    'duração',
    'grau',
    'bolsa',
    'mensalidade',
    'campus',
    'polo',
    'periodo',
  ];

  const lines = results.flatMap((result) =>
    String(result.content || '')
      .split('\n')
      .map(stripMd)
      .filter((line) => line.length >= 3 && line.length <= 90),
  );

  const filtered = lines.filter((line) => {
    const normalized = normalize(line);
    if (!normalized) return false;
    if (blocked.some((term) => normalized.includes(term))) return false;
    if (/^\d+$/.test(normalized)) return false;
    return true;
  });

  const withFilenames = [
    ...filtered,
    ...results.map((result) => cleanFilename(result.filename)).filter(Boolean),
  ];

  return unique(withFilenames)
    .slice(0, 12);
}

function formatList(items: string[]) {
  return items.map((item) => `- ${item}`).join('\n');
}

export async function resolveCatalogMessage(params: {
  apiKey: string;
  vectorStoreId: string;
  message: string;
  leadName?: string | null;
  history?: Array<{ role?: string; content?: string }>;
}) {
  return null;
}
