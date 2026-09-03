// tools.ts - Implementacao das tools do Agente de Vendas Fapps
// deno-lint-ignore-file
// @ts-nocheck

import { detectContextualReplyKind } from './catalog-resolver.ts';
import { queryKnowledgeBase } from './knowledge.ts';
import { getPendingAdminCheckpoint } from '../_shared/admin-checkpoints.ts';
import { getCourseDisplayName } from '../_shared/course-display.ts';

export interface ToolContext {
    supabase: any;
    tenantId: string;
    leadId: string;
    telefone: string;
    env: Record<string, string>;
}

const PROXIMA_ETAPA: Record<string, string> = {
    E1: 'E2',
    E2: 'E3',
    E3: 'E4',
    E4: 'E5',
    E5: 'E6',
    E6: 'E7',
    E7: 'encerrado',
};

function normalizeCourseText(text: string) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildSpecificCourseQueryVariants(query: string) {
    const normalized = normalizeCourseText(query);
    const simplified = normalized
        .replace(/\baudio transcrito\b/g, ' ')
        .replace(/\b(quero saber sobre|quero fazer|tenho interesse em|estou pensando em|quero informacoes de|queria informacoes de|informacoes de|curso de|graduacao de|faculdade de|tem o curso de|tem curso de|tem)\b/g, ' ')
        .replace(/\b(eu|a|o|as|os|uma|um|voce|voces|nao)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return uniqueStrings([
        normalized,
        simplified,
        normalizeBaseCourseName(query),
    ]).filter(Boolean);
}

function uniqueStrings(items: string[]) {
    return Array.from(new Set(items.filter(Boolean)));
}

function hasMeaningfulLeadValue(value: unknown) {
    return String(value || '').trim().length > 0;
}

function normalizeLineFormation(value: unknown) {
    const normalized = normalizeCourseText(String(value || ''));
    if (!normalized) return '';
    if (normalized.includes('licenciatura')) return 'Licenciatura';
    if (normalized.includes('bacharelado')) return 'Bacharelado';
    if (normalized.includes('tecnologo')) return 'Tecnologo';
    if (normalized.includes('tecnico')) return 'Tecnico';
    return '';
}

function isAllowedDeliveryMode(value: unknown) {
    const normalized = normalizeCourseText(String(value || ''));
    return ['ead', 'semipresencial'].includes(normalized);
}

function isAllowedLegacyPain(value: unknown) {
    const normalized = normalizeCourseText(String(value || ''));
    return ['tempo', 'dinheiro', 'ambos'].includes(normalized);
}

async function validateStageAdvance(ctx: ToolContext, currentStage: string, nextStage: string) {
    const pendingCheckpoint = await getPendingAdminCheckpoint(ctx.supabase, ctx.leadId);
    if (pendingCheckpoint?.id) {
        return {
            ok: false,
            blocked: true,
            reason: 'pending_admin_checkpoint',
            checkpoint_admin: pendingCheckpoint.checkpoint_admin,
            etapa_atual: currentStage,
            etapa_destino: nextStage,
        };
    }

    if (currentStage !== 'E1' || nextStage !== 'E2') {
        return { ok: true };
    }

    const { data: leadSnapshot, error } = await ctx.supabase
        .from('leads')
        .select('nome, cidade, curso_interesse, modalidade, dor_principal, sales_context')
        .eq('id', ctx.leadId)
        .maybeSingle();

    if (error) throw new Error(`Erro ao validar avance de etapa: ${error.message}`);

    const salesContext = { ...(leadSnapshot?.sales_context || {}) } as Record<string, unknown>;
    const courseValidated = salesContext.course_validated === true || hasMeaningfulLeadValue(leadSnapshot?.curso_interesse);
    const lineSelectionRequired = salesContext.line_selection_required === true;
    const lineResolved = !lineSelectionRequired || hasMeaningfulLeadValue(salesContext.linha_formacao);
    const motivationKnown = hasMeaningfulLeadValue(salesContext.motivacao_principal) || hasMeaningfulLeadValue(leadSnapshot?.dor_principal);
    const missingFields = [
        !hasMeaningfulLeadValue(leadSnapshot?.cidade) ? 'cidade' : null,
        !courseValidated ? 'curso_validado' : null,
        lineSelectionRequired && !lineResolved ? 'linha_formacao' : null,
        !motivationKnown ? 'motivacao_principal' : null,
    ].filter(Boolean);

    if (missingFields.length === 0) {
        return { ok: true };
    }

    return {
        ok: false,
        blocked: true,
        reason: 'missing_e1_requirements',
        missing_fields: missingFields,
        etapa_atual: currentStage,
        etapa_destino: nextStage,
    };
}

function mergeVectorResults(...groups: any[][]) {
    const merged: any[] = [];
    const seen = new Set<string>();

    for (const group of groups) {
        for (const item of group || []) {
            const key = `${item?.file_id || ''}::${item?.filename || ''}::${item?.content || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(item);
        }
    }

    return merged;
}

function cleanupCourseLabel(text: string) {
    return String(text || '')
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractVectorCourseCandidates(results: any[]) {
    const candidates: string[] = [];

    for (const result of results || []) {
        const content = String(result?.content || '');
        const lines = content.split('\n');

        for (const rawLine of lines) {
            const line = cleanupCourseLabel(rawLine);
            if (!line) continue;

            const tableMatch = line.match(/^\|\s*([^|]+?)\s*\|/);
            if (tableMatch?.[1]) {
                candidates.push(cleanupCourseLabel(tableMatch[1]));
            }

            const bulletMatch = line.match(/^[-*]\s+(.+)$/);
            if (bulletMatch?.[1]) {
                candidates.push(cleanupCourseLabel(bulletMatch[1]));
            }
        }
    }

    return uniqueStrings(candidates)
        .filter((candidate) => candidate.length >= 3 && candidate.length <= 140);
}

function courseCandidateMatchesQuery(candidate: string, query: string) {
    const normalizedCandidate = normalizeCourseText(candidate);
    const normalizedQuery = normalizeCourseText(query);
    if (!normalizedCandidate || !normalizedQuery) return false;

    if (normalizedCandidate === normalizedQuery) return true;
    if (normalizedCandidate.includes(`${normalizedQuery} (`)) return true;
    if (normalizedCandidate.startsWith(`${normalizedQuery} `)) return true;

    const queryTokens = normalizedQuery
        .split(' ')
        .filter((token) => token.length >= 3);

    if (!queryTokens.length) return false;
    const candidateWords = normalizedCandidate.split(' ').filter((token) => token.length >= 2);
    return queryTokens.every((token) => candidateWords.includes(token));
}

function extractDegreeHint(query: string) {
    const normalizedQuery = normalizeCourseText(query);
    if (/\bbacharelado\b/.test(normalizedQuery)) return 'bacharelado';
    if (/\blicenciatura\b/.test(normalizedQuery)) return 'licenciatura';
    if (/\btecnologo\b|\btecnologos\b/.test(normalizedQuery)) return 'tecnologo';
    if (/\btecnico\b/.test(normalizedQuery)) return 'tecnico';
    return '';
}

function simplifyCourseLookupQuery(query: string) {
    return normalizeCourseText(query)
        .replace(/\b(quero saber sobre|quero fazer|tenho interesse em|estou pensando em|quero informacoes de|quero informações de|queria informacoes de|queria informações de|informacoes de|informações de|curso de|tem o curso de|tem curso de|tem)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeBaseCourseName(candidate: string) {
    return normalizeCourseText(candidate)
        .replace(/\(\s*bacharelado\s*\)/g, '')
        .replace(/\(\s*licenciatura\s*\)/g, '')
        .replace(/\(\s*p\s*egresso[^)]*\)/g, '')
        .replace(/\(\s*area basica de ingresso\s*\)/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function displayBaseCourseName(candidate: string) {
    return getCourseDisplayName(candidate);
}

function isEgressoVariant(candidate: string) {
    return /\(\s*p\s*egresso/i.test(candidate || '');
}

function candidateMatchesDegree(candidate: string, degreeHint: string) {
    if (!degreeHint) return true;
    const normalizedCandidate = normalizeCourseText(candidate);
    if (degreeHint === 'tecnologo') return normalizedCandidate.startsWith('cst ');
    if (degreeHint === 'tecnico') return normalizedCandidate.includes(' tecnico ') || normalizedCandidate.startsWith('tecnico ');
    return normalizedCandidate.includes(`(${degreeHint})`) || normalizedCandidate.endsWith(` ${degreeHint}`);
}

function buildStrictCourseNames(entry: any) {
    const names = [
        String(entry.display_name || ''),
        String(entry.canonical_name || ''),
        ...((entry.course_catalog_aliases || []).map((alias: any) => String(alias.alias_text || ''))),
    ]
        .map((value) => normalizeCourseText(value))
        .filter(Boolean);

    const expanded = names.flatMap((name) => {
        const base = normalizeBaseCourseName(name);
        return uniqueStrings([name, base]);
    });

    return uniqueStrings(expanded);
}

function isStrictSpecificCourseMatch(entry: any, query: string) {
    const normalizedQuery = normalizeCourseText(query);
    const normalizedBaseQuery = normalizeBaseCourseName(query);
    if (!normalizedQuery || !normalizedBaseQuery) return false;

    const strictNames = buildStrictCourseNames(entry);
    return strictNames.some((name) => name === normalizedQuery || name === normalizedBaseQuery);
}

function hasExplicitAreaIntent(query: string) {
    const normalizedQuery = normalizeCourseText(query);
    return [
        'na area',
        'area de',
        'area da',
        'area do',
        'outra area',
        'nessa area',
        'quais cursos',
        'que cursos',
        'cursos voces tem',
        'cursos voce tem',
        'cursos tem',
    ].some((pattern) => normalizedQuery.includes(pattern));
}

function hasBroadBrowseIntent(query: string) {
    const normalizedQuery = normalizeCourseText(query);
    return [
        'quais opcoes',
        'quais opcoes tem',
        'quais graduacoes',
        'quais graduacoes voces oferecem',
        'quais graduacoes voce oferece',
        'estou procurando uma graduacao',
        'quero ver os cursos',
        'quais cursos',
        'que cursos',
        'cursos voces tem',
        'cursos voce tem',
        'cursos tem',
        'na area',
        'area de',
        'area da',
        'area do',
        'outra area',
        'nessa area',
        'por modalidade',
        'por duracao',
        'por grau',
    ].some((pattern) => normalizedQuery.includes(pattern));
}

function detectCatalogLookupMode(query: string) {
    const normalizedQuery = normalizeCourseText(query);
    if (!normalizedQuery) return 'specific';

    if (hasBroadBrowseIntent(normalizedQuery) && !hasExplicitAreaIntent(normalizedQuery)) {
        return 'browse_catalog';
    }

    if (hasExplicitAreaIntent(normalizedQuery)) {
        return 'browse_area';
    }

    if (
        /\b(ead|semipresencial|presencial|bacharelado|licenciatura|tecnologo|tecnologos|tecnico|duracao|modalidade|grau)\b/.test(normalizedQuery)
    ) {
        return 'browse_filter';
    }

    return 'specific';
}

function resolveSpecificCourseCandidates(query: string, courseCandidates: string[]) {
    const normalizedQuery = normalizeCourseText(query);
    const degreeHint = extractDegreeHint(normalizedQuery);
    const directMatches = courseCandidates.filter((candidate) => courseCandidateMatchesQuery(candidate, normalizedQuery));
    const degreeFiltered = directMatches.filter((candidate) => candidateMatchesDegree(candidate, degreeHint));
    const effectiveMatches = degreeFiltered.length > 0 ? degreeFiltered : directMatches;
    if (!effectiveMatches.length) {
        return {
            status: 'not_found',
            matchedCourses: [] as string[],
            listedCourses: [] as string[],
        };
    }

    const grouped = new Map<string, string[]>();
    for (const candidate of effectiveMatches) {
        const baseName = normalizeBaseCourseName(candidate);
        const list = grouped.get(baseName) || [];
        list.push(candidate);
        grouped.set(baseName, list);
    }

    const sameBaseGroups = Array.from(grouped.entries())
        .filter(([baseName]) => baseName === normalizeBaseCourseName(query) || normalizeBaseCourseName(query).includes(baseName) || baseName.includes(normalizeBaseCourseName(query)));

    const groupCandidates = (sameBaseGroups[0]?.[1] || effectiveMatches).filter(Boolean);
    const primaryTracks = groupCandidates.filter((candidate) => !isEgressoVariant(candidate));

    if (degreeHint) {
        const exactDegree = primaryTracks.filter((candidate) => candidateMatchesDegree(candidate, degreeHint));
        if (exactDegree.length === 1) {
            return { status: 'found', matchedCourses: [exactDegree[0]], listedCourses: [] as string[] };
        }
    }

    const distinctPrimaryBase = uniqueStrings(primaryTracks.map((candidate) => normalizeCourseText(candidate)));
    if (primaryTracks.length > 1 && distinctPrimaryBase.length > 1) {
        return {
            status: 'ambiguous_found',
            matchedCourses: [] as string[],
            listedCourses: primaryTracks.slice(0, 6),
        };
    }

    if (primaryTracks.length >= 1) {
        return {
            status: 'found',
            matchedCourses: [primaryTracks[0]],
            listedCourses: [] as string[],
        };
    }

    if (groupCandidates.length === 1) {
        return {
            status: 'found',
            matchedCourses: [groupCandidates[0]],
            listedCourses: [] as string[],
        };
    }

    return {
        status: 'ambiguous_found',
        matchedCourses: [] as string[],
        listedCourses: groupCandidates.slice(0, 6),
    };
}

function looksLikeCourseContextFollowupQuery(query: string) {
  const normalized = normalizeCourseText(query);
  if (!normalized) return false;

    const exact = new Set([
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
        'qual modalidade',
        'ead',
        'semipresencial',
        'presencial',
    ]);
    if (exact.has(normalized)) return true;

    const patterns = [
        'como funciona o curso',
        'como funciona essa graduacao',
        'como funciona essa graduação',
        'quero saber mais',
        'me fala mais',
        'me explique melhor',
        'quero mais informacoes',
        'quero mais informações',
        'sobre valores',
        'sobre o valor',
        'sobre bolsa',
        'sobre a bolsa',
        'sobre duracao',
        'sobre duração',
        'sobre modalidade',
  ];
  return patterns.some((pattern) => normalized.includes(pattern));
}

function looksLikeLikelyCityReply(query: string) {
    const normalized = normalizeCourseText(query);
    if (!normalized) return false;

    const words = normalized.split(' ').filter(Boolean);
    if (words.length === 0 || words.length > 4) return false;

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
        'curso',
        'cursos',
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
    ].includes(word));

    if (hasCatalogVerb) return false;
    return true;
}

function isMeaningfulCityValue(value: string) {
    const normalized = normalizeCourseText(value);
    if (!normalized) return false;

    if (!looksLikeLikelyCityReply(normalized)) return false;

    if (
        normalized.startsWith('sou de ')
        || normalized.startsWith('moro em ')
        || normalized.startsWith('resido em ')
        || normalized.startsWith('sou do ')
        || normalized.startsWith('sou da ')
    ) {
        return true;
    }

    const words = normalized.split(' ').filter(Boolean);
    if (words.length === 0 || words.length > 4) return false;

    const forbiddenWords = new Set([
        'minha',
        'meu',
        'area',
        'trabalho',
        'atuo',
        'objetivo',
        'sonho',
        'curso',
        'faculdade',
    ]);

    return words.every((word) => !forbiddenWords.has(word));
}

function detectDeliveryModeHint(query: string) {
    const normalizedQuery = normalizeCourseText(query);
    if (normalizedQuery.includes('semipresencial')) return 'semipresencial';
    if (normalizedQuery.includes('presencial')) return 'presencial';
    if (/\bead\b/.test(normalizedQuery)) return 'ead';
    return '';
}

function extractCourseSearchTokens(query: string) {
    const stopwords = new Set([
        'quero', 'queria', 'gostaria', 'tenho', 'interesse', 'curso', 'cursos', 'tem', 'temos',
        'saber', 'sobre', 'mais', 'como', 'qual', 'quais', 'na', 'no', 'de', 'da', 'do', 'das', 'dos',
        'um', 'uma', 'pra', 'para', 'com', 'em', 'modalidade', 'duracao', 'duracao', 'area', 'areas',
        'bacharelado', 'licenciatura', 'tecnologo', 'tecnologos', 'ead', 'semipresencial', 'presencial',
    ]);

    return uniqueStrings(
        normalizeCourseText(query)
            .split(' ')
            .map((token) => token.trim())
            .filter((token) => token.length >= 3 && !stopwords.has(token)),
    );
}

function detectAreaHints(query: string) {
    return [] as string[];
}

function detectAreaHintsFromEntries(query: string, entries: any[]) {
    const normalizedQuery = normalizeCourseText(query);
    if (!normalizedQuery) return [];

    const tokens = extractCourseSearchTokens(query);
    const areaMatches = new Map<string, { slug: string; name: string; score: number }>();

    for (const entry of entries || []) {
        const areaSlug = String(entry.area_slug || '').trim();
        const areaName = String(entry.area_name || '').trim();
        if (!areaSlug || !areaName) continue;

        const normalizedAreaName = normalizeCourseText(areaName);
        let score = 0;

        if (normalizedQuery.includes(normalizedAreaName)) score += 100;
        if (normalizedQuery.includes(areaSlug.replace(/-/g, ' '))) score += 80;

        for (const token of tokens) {
            if (normalizedAreaName.includes(token)) score += 20;
            if (areaSlug.includes(token)) score += 12;
        }

        if (score <= 0) continue;

        const current = areaMatches.get(areaSlug);
        if (!current || score > current.score) {
            areaMatches.set(areaSlug, { slug: areaSlug, name: areaName, score });
        }
    }

    return [...areaMatches.values()]
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .map((item) => item.slug);
}

function inferRequestedAreaFromQuery(query: string, entries: any[]) {
    const hintedSlugs = detectAreaHintsFromEntries(query, entries);
    if (hintedSlugs.length > 0) {
        const matchedEntry = entries.find((entry) => hintedSlugs.includes(String(entry.area_slug || '')));
        return {
            slug: hintedSlugs[0],
            name: String(matchedEntry?.area_name || hintedSlugs[0] || '').trim(),
        };
    }

    const ranked = entries
        .map((entry) => ({ entry, score: scoreStructuredCourseEntry(entry, query) }))
        .filter((item) => item.score >= 40)
        .sort((a, b) => b.score - a.score);

    const best = ranked[0]?.entry;
    if (!best?.area_slug) {
        return { slug: '', name: '' };
    }

    return {
        slug: String(best.area_slug || '').trim(),
        name: String(best.area_name || best.area_slug || '').trim(),
    };
}

function resolveRequestedSegment(query: string, entries: any[]) {
    const normalizedQuery = normalizeCourseText(query);
    const availableAreas = listAvailableAreas(entries);
    const availableAreaKeys = new Map(
        availableAreas.map((area) => [normalizeCourseText(area), area]),
    );
    if (!normalizedQuery || availableAreas.length === 0) {
        return {
            slug: '',
            name: '',
            confidence: 'none',
            source: 'semantic_segment_resolution',
            candidate: null,
            availableAreas,
        };
    }

    const closedTaxonomyHints: Record<string, string[]> = {
        'saude e beleza': [
            'psicoterapia',
            'terapia',
            'terapeuta',
            'psicologia',
            'saude mental',
            'clinica',
            'bem estar',
            'estetica',
            'enfermagem',
            'fisioterapia',
            'nutricao',
        ],
        'educacao': ['pedagogia', 'professor', 'ensino', 'licenciatura', 'educacao'],
        'tecnologia': ['sistemas', 'programacao', 'dados', 'computacao', 'software', 'tecnologia', 'ti'],
        'gestao e negocios': ['administracao', 'gestao', 'negocios', 'marketing', 'logistica', 'contabilidade', 'rh'],
        'juridico e publico': ['direito', 'juridico', 'servico publico', 'gestao publica'],
        'ambiental e agro': ['agro', 'agronomia', 'ambiental', 'agricultura', 'veterinaria'],
        'design e criacao': ['design', 'moda', 'criacao'],
        'criacao e midia': ['midia', 'comunicacao', 'publicidade', 'jornalismo'],
        'gastronomia': ['gastronomia', 'culinaria', 'cozinha'],
    };

    const scored = [...availableAreaKeys.entries()]
        .map(([areaKey, areaName]) => {
            const hints = closedTaxonomyHints[areaKey] || [];
            const score = hints.reduce((total, hint) => (
                normalizedQuery.includes(hint) ? total + (hint.length >= 8 ? 80 : 45) : total
            ), normalizedQuery.includes(areaKey) ? 100 : 0);
            return { areaKey, areaName, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.areaName.localeCompare(b.areaName, 'pt-BR'));

    const best = scored[0];
    const second = scored[1];
    if (!best || best.score < 45 || (second && best.score - second.score < 25)) {
        return {
            slug: '',
            name: '',
            confidence: best ? 'low' : 'none',
            source: 'semantic_segment_resolution',
            candidate: best?.areaName || null,
            availableAreas,
        };
    }

    if (best.score < 80) {
        return {
            slug: '',
            name: '',
            confidence: 'low',
            source: 'semantic_segment_resolution',
            candidate: best.areaName,
            availableAreas,
        };
    }

    const matchedEntry = entries.find((entry) => normalizeCourseText(String(entry.area_name || '')) === best.areaKey);
    return {
        slug: String(matchedEntry?.area_slug || best.areaKey.replace(/\s+/g, '-')).trim(),
        name: best.areaName,
        confidence: 'high',
        source: 'semantic_segment_resolution',
        candidate: best.areaName,
        availableAreas,
    };
}

function listAreaCoursesBySlug(entries: any[], areaSlug: string) {
    if (!areaSlug) return [];
    return uniqueStrings(
        entries
            .filter((entry) => String(entry.area_slug || '') === areaSlug)
            .map((entry) => getCourseDisplayName(String(entry.display_name || '').trim()))
            .filter(Boolean),
    ).slice(0, 12);
}

function listAvailableAreas(entries: any[]) {
    const seen = new Set<string>();
    const areas: string[] = [];

    for (const entry of entries || []) {
        const areaName = String(entry.area_name || '').trim();
        const normalized = normalizeCourseText(areaName);
        if (!areaName || !normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        areas.push(areaName);
    }

    return areas.sort((a, b) => a.localeCompare(b, 'pt-BR')).slice(0, 20);
}

function listAvailableCourseLines(courses: string[]) {
    return uniqueStrings(
        (courses || [])
            .map((course) => normalizeLineFormation(course))
            .filter(Boolean),
    );
}

function normalizeCourseStateFromLookup(params: {
    lookupMode: string;
    matchStatus: string;
    requestedAreaSlug: string;
    requestedAreaName: string;
    relatedAreaCourses: string[];
}) {
    const relatedAreaCourses = (params.relatedAreaCourses || []).filter(Boolean);
    const hasReliableArea = Boolean(String(params.requestedAreaSlug || '').trim() && String(params.requestedAreaName || '').trim());
    const hasAlternatives = relatedAreaCourses.length > 0;

    if (params.lookupMode === 'specific' && params.matchStatus === 'found') {
        return {
            course_status: 'confirmed_available',
            requested_area_slug: params.requestedAreaSlug || null,
            requested_area_name: params.requestedAreaName || null,
            related_area_courses: relatedAreaCourses,
        };
    }

    if (params.lookupMode === 'specific' && params.matchStatus === 'ambiguous_found') {
        return {
            course_status: 'ambiguous_available',
            requested_area_slug: params.requestedAreaSlug || null,
            requested_area_name: params.requestedAreaName || null,
            related_area_courses: relatedAreaCourses,
        };
    }

    if (params.lookupMode === 'specific' && params.matchStatus === 'not_found') {
        return hasReliableArea && hasAlternatives
            ? {
                course_status: 'segment_options_available',
                requested_area_slug: params.requestedAreaSlug,
                requested_area_name: params.requestedAreaName,
                related_area_courses: relatedAreaCourses,
            }
            : {
                course_status: 'segment_unavailable',
                requested_area_slug: null,
                requested_area_name: null,
                related_area_courses: [],
            };
    }

    if (params.lookupMode === 'browse_catalog') {
        return {
            course_status: 'catalog_exploration',
            requested_area_slug: null,
            requested_area_name: null,
            related_area_courses: [],
        };
    }

    if (params.lookupMode !== 'specific') {
        return hasReliableArea && hasAlternatives
            ? {
                course_status: 'catalog_area_selected',
                requested_area_slug: params.requestedAreaSlug,
                requested_area_name: params.requestedAreaName,
                related_area_courses: relatedAreaCourses,
            }
            : {
                course_status: 'segment_unavailable',
                requested_area_slug: null,
                requested_area_name: null,
                related_area_courses: [],
            };
    }

    return {
        course_status: null,
        requested_area_slug: null,
        requested_area_name: null,
        related_area_courses: [],
    };
}

function buildStructuredCourseLabel(entry: any) {
    const parts = [
        entry.display_name,
        entry.duration_text ? `| ${entry.duration_text}` : '',
        entry.delivery_mode ? `| ${String(entry.delivery_mode).toUpperCase()}` : '',
    ].filter(Boolean);
    return parts.join(' ');
}

function scoreStructuredCourseEntry(entry: any, query: string) {
    const normalizedQuery = normalizeCourseText(query);
    const tokens = extractCourseSearchTokens(query);
    const aliasTexts = (entry.course_catalog_aliases || []).map((alias: any) => String(alias.alias_text || ''));
    const haystacks = [
        String(entry.display_name || ''),
        String(entry.canonical_name || ''),
        String(entry.normalized_search_text || ''),
        ...aliasTexts,
    ].map((item) => normalizeCourseText(item));

    let score = 0;
    for (const haystack of haystacks) {
        if (!haystack) continue;
        if (haystack === normalizedQuery) score += 120;
        if (haystack.includes(normalizedQuery)) score += 60;
    }

    for (const token of tokens) {
        for (const haystack of haystacks) {
            if (haystack.includes(token)) {
                score += 12;
                break;
            }
        }
    }

    const degreeHint = extractDegreeHint(query);
    if (degreeHint && String(entry.degree_level || '') === degreeHint) score += 25;

    const deliveryHint = detectDeliveryModeHint(query);
    if (deliveryHint && String(entry.delivery_mode || '') === deliveryHint) score += 20;

    const areaHints = [] as string[];
    if (areaHints.length && areaHints.includes(String(entry.area_slug || ''))) score += 15;

    return score;
}

async function fetchStructuredCourseEntries(ctx: ToolContext) {
    const { data, error } = await ctx.supabase
        .from('course_catalog_entries')
        .select(`
            id,
            source_key,
            catalog_group,
            area_slug,
            area_name,
            canonical_name,
            display_name,
            normalized_canonical_name,
            normalized_display_name,
            normalized_search_text,
            degree_level,
            delivery_mode,
            duration_semesters,
            duration_years,
            duration_text,
            variant_kind,
            course_catalog_aliases (
                alias_text,
                normalized_alias_text,
                alias_kind,
                is_primary
            )
        `)
        .eq('tenant_id', ctx.tenantId)
        .eq('active', true)
        .order('display_name', { ascending: true });

    if (error?.message?.includes('does not exist') || error?.message?.includes('relation')) {
        return [];
    }
    if (error) throw error;
    return data || [];
}

function resolveStructuredSpecificCourses(query: string, entries: any[]) {
    const queryVariants = buildSpecificCourseQueryVariants(query);
    const degreeHint = extractDegreeHint(query);
    const grouped = entries
        .map((entry) => ({
            entry,
            score: Math.max(...queryVariants.map((variant) => scoreStructuredCourseEntry(entry, variant))),
        }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || String(a.entry.display_name || '').localeCompare(String(b.entry.display_name || '')));

    const strictMatches = grouped
        .map((item) => item.entry)
        .filter((entry) => queryVariants.some((variant) => isStrictSpecificCourseMatch(entry, variant)));

    const strictDegreeFiltered = degreeHint
        ? strictMatches.filter((entry) =>
            String(entry.degree_level || '') === degreeHint
            || candidateMatchesDegree(String(entry.display_name || ''), degreeHint))
        : strictMatches;

    const effectiveStrictMatches = strictDegreeFiltered.length > 0 ? strictDegreeFiltered : strictMatches;

    if (effectiveStrictMatches.length > 0) {
        const distinctStrictEntries = uniqueStrings(
            effectiveStrictMatches.map((entry) => `${entry.display_name}::${entry.delivery_mode}`),
        )
            .map((key) => effectiveStrictMatches.find((entry) => `${entry.display_name}::${entry.delivery_mode}` === key))
            .filter(Boolean);

        if (distinctStrictEntries.length === 1) {
            return {
                status: 'found',
                matchedEntries: [distinctStrictEntries[0]],
                listedEntries: [],
                candidates: grouped.slice(0, 12).map((item) => item.entry.display_name),
                bestAreaSlug: String(distinctStrictEntries[0]?.area_slug || ''),
                bestAreaName: String(distinctStrictEntries[0]?.area_name || ''),
            };
        }

        return {
            status: 'ambiguous_found',
            matchedEntries: [],
            listedEntries: distinctStrictEntries.slice(0, 6),
            candidates: grouped.slice(0, 12).map((item) => item.entry.display_name),
            bestAreaSlug: String(distinctStrictEntries[0]?.area_slug || ''),
            bestAreaName: String(distinctStrictEntries[0]?.area_name || ''),
        };
    }

    const effective = degreeHint
        ? grouped.filter((item) => String(item.entry.degree_level || '') === degreeHint || item.score >= 100)
        : grouped;

    if (!effective.length) {
        return {
            status: 'not_found',
            matchedEntries: [] as any[],
            listedEntries: [] as any[],
            candidates: [] as string[],
            bestAreaSlug: '',
            bestAreaName: '',
        };
    }

    return {
        status: 'not_found',
        matchedEntries: [] as any[],
        listedEntries: [] as any[],
        candidates: grouped.slice(0, 12).map((item) => item.entry.display_name),
        bestAreaSlug: String(grouped[0]?.entry?.area_slug || ''),
        bestAreaName: String(grouped[0]?.entry?.area_name || ''),
    };
}

function browseStructuredCourses(query: string, entries: any[]) {
    const degreeHint = extractDegreeHint(query);
    const deliveryHint = detectDeliveryModeHint(query);
    const areaHints = detectAreaHintsFromEntries(query, entries);
    const tokens = extractCourseSearchTokens(query);

    const filtered = entries.filter((entry) => {
        if (degreeHint && String(entry.degree_level || '') !== degreeHint) return false;
        if (deliveryHint && String(entry.delivery_mode || '') !== deliveryHint) return false;
        if (areaHints.length && !areaHints.includes(String(entry.area_slug || ''))) return false;

        if (!tokens.length) return true;
        const haystack = normalizeCourseText([
            entry.display_name,
            entry.canonical_name,
            entry.area_name,
            entry.normalized_search_text,
            ...(entry.course_catalog_aliases || []).map((alias: any) => alias.alias_text),
        ].filter(Boolean).join(' '));

        return tokens.every((token) => haystack.includes(token));
    });

    const ranked = filtered
        .map((entry) => ({ entry, score: scoreStructuredCourseEntry(entry, query) }))
        .sort((a, b) => b.score - a.score || String(a.entry.display_name || '').localeCompare(String(b.entry.display_name || '')))
        .map((item) => item.entry);

    return ranked.slice(0, 12);
}

export async function tool_ler_lead(ctx: ToolContext, _args: {}) {
    const { data, error } = await ctx.supabase
        .from('leads')
        .select('nome, cidade, curso_interesse, modalidade, dor_principal, decisor_confirmado, viagem_programada, valor_parcela, etapa_atual, matriculado, bloqueado, proposta_enviada_em, pronto_matricula_em, ultimo_resumo_ia, sales_context')
        .eq('id', ctx.leadId)
        .single();

    if (error) throw new Error(`Erro ao ler lead: ${error.message}`);
    return data;
}

export async function tool_atualizar_lead(
    ctx: ToolContext,
    args: {
        nome?: string;
        cidade?: string;
        curso_interesse?: string;
        modalidade?: 'ead' | 'semipresencial';
        dor_principal?: 'tempo' | 'dinheiro' | 'ambos';
        decisor_confirmado?: boolean;
        viagem_programada?: boolean;
        valor_parcela?: number;
    },
) {
    const sanitizedArgs = { ...args } as Record<string, unknown>;
    const ignoredFields: string[] = [];
    const salesContextPatch: Record<string, unknown> = {};

    if (typeof sanitizedArgs.cidade === 'string') {
        const cidade = String(sanitizedArgs.cidade || '').trim();
        if (!isMeaningfulCityValue(cidade)) {
            delete sanitizedArgs.cidade;
            ignoredFields.push('cidade');
        } else {
            sanitizedArgs.cidade = cidade;
        }
    }

    if (typeof sanitizedArgs.modalidade === 'string') {
        const lineFormation = normalizeLineFormation(sanitizedArgs.modalidade);
        if (lineFormation) {
            salesContextPatch.linha_formacao = lineFormation;
            delete sanitizedArgs.modalidade;
        } else if (!isAllowedDeliveryMode(sanitizedArgs.modalidade)) {
            delete sanitizedArgs.modalidade;
            ignoredFields.push('modalidade');
        }
    }

    if (typeof sanitizedArgs.dor_principal === 'string' && !isAllowedLegacyPain(sanitizedArgs.dor_principal)) {
        const motivation = String(sanitizedArgs.dor_principal || '').trim();
        if (motivation) {
            salesContextPatch.motivacao_principal = motivation;
        }
        delete sanitizedArgs.dor_principal;
        ignoredFields.push('dor_principal');
    }

    const campos = { ...sanitizedArgs, updated_at: new Date().toISOString() };

    if (Object.keys(sanitizedArgs).length === 0 && Object.keys(salesContextPatch).length === 0) {
        return { ok: true, campos_salvos: [], campos_ignorados: ignoredFields };
    }

    if (Object.keys(salesContextPatch).length > 0) {
        const { data: currentLead, error: currentLeadError } = await ctx.supabase
            .from('leads')
            .select('sales_context')
            .eq('id', ctx.leadId)
            .maybeSingle();

        if (currentLeadError) throw new Error(`Erro ao ler sales_context: ${currentLeadError.message}`);

        campos.sales_context = {
            ...(currentLead?.sales_context || {}),
            ...salesContextPatch,
        };
    }

    const { error } = await ctx.supabase
        .from('leads')
        .update(campos)
        .eq('id', ctx.leadId);

    if (error) throw new Error(`Erro ao atualizar lead: ${error.message}`);
    return { ok: true, campos_salvos: [...Object.keys(sanitizedArgs), ...Object.keys(salesContextPatch)], campos_ignorados: ignoredFields };
}

export async function tool_avancar_etapa(
    ctx: ToolContext,
    args: { etapa_destino?: string },
) {
    const { data: lead, error: errLeitura } = await ctx.supabase
        .from('leads')
        .select('etapa_atual')
        .eq('id', ctx.leadId)
        .single();

    if (errLeitura) throw new Error(`Erro ao ler etapa: ${errLeitura.message}`);

    const etapaDestino = args.etapa_destino ?? PROXIMA_ETAPA[lead.etapa_atual];
    if (!etapaDestino) throw new Error(`Nao ha proxima etapa para: ${lead.etapa_atual}`);

    const validation = await validateStageAdvance(ctx, String(lead.etapa_atual || ''), String(etapaDestino || ''));
    if (!validation.ok) {
        return validation;
    }

    const { error } = await ctx.supabase
        .from('leads')
        .update({
            etapa_atual: etapaDestino,
            updated_at: new Date().toISOString(),
        })
        .eq('id', ctx.leadId);

    if (error) throw new Error(`Erro ao avancar etapa: ${error.message}`);

    return {
        ok: true,
        etapa_anterior: lead.etapa_atual,
        etapa_atual: etapaDestino,
    };
}

export async function tool_registrar_matricula(
    ctx: ToolContext,
    args: { valor_pago: number; forma_pagamento: string },
) {
    const { error } = await ctx.supabase
        .from('leads')
        .update({
            matriculado: true,
            matricula_em: new Date().toISOString(),
            valor_matricula: args.valor_pago,
            updated_at: new Date().toISOString(),
        })
        .eq('id', ctx.leadId);

    if (error) throw new Error(`Erro ao registrar matricula: ${error.message}`);

    return {
        ok: true,
        mensagem: 'Matricula registrada com sucesso!',
        forma_pagamento: args.forma_pagamento,
    };
}

export async function tool_registrar_indicacao(
    ctx: ToolContext,
    args: { telefone_indicado: string; nome_indicado?: string },
) {
    const { error } = await ctx.supabase
        .from('indicacoes')
        .insert({
            tenant_id: ctx.tenantId,
            lead_origem_id: ctx.leadId,
            telefone_indicado: args.telefone_indicado,
            nome_indicado: args.nome_indicado ?? null,
            status: 'pendente',
        });

    if (error && !error.message.includes('duplicate')) {
        throw new Error(`Erro ao registrar indicacao: ${error.message}`);
    }

    return { ok: true, telefone: args.telefone_indicado };
}

export async function tool_acionar_handoff(
    ctx: ToolContext,
    args: { motivo: string },
) {
    const { error } = await ctx.supabase
        .from('leads')
        .update({
            bloqueado: true,
            handoff_em: new Date().toISOString(),
            etapa_atual: 'handoff',
            updated_at: new Date().toISOString(),
        })
        .eq('id', ctx.leadId);

    if (error) throw new Error(`Erro ao acionar handoff: ${error.message}`);

    return {
        ok: true,
        mensagem: 'Recebi sua mensagem e ja chamei alguem da nossa equipe pra te ajudar com isso, ok?',
        motivo: args.motivo,
    };
}

export async function tool_consultar_conhecimento(
    ctx: ToolContext,
    args: { tipo?: string; query?: string; lookup_mode_hint?: string | null },
) {
    const normalizedType = String(args.tipo || '').trim().toLowerCase();
    const normalizedQuery = String(args.query || '').trim();

    if (normalizedType === 'course' && normalizedQuery) {
        const [{ data: leadContext }, { data: recentMessages }] = await Promise.all([
            ctx.supabase
            .from('leads')
            .select('curso_interesse, cidade')
            .eq('id', ctx.leadId)
            .maybeSingle(),
            ctx.supabase
                .from('mensagens')
                .select('role, conteudo')
                .eq('lead_id', ctx.leadId)
                .order('created_at', { ascending: false })
                .limit(8),
        ]);

        const currentCourseInterest = String(leadContext?.curso_interesse || '').trim();
        const currentCity = String(leadContext?.cidade || '').trim();
        const history = (recentMessages || [])
            .slice()
            .reverse()
            .map((message: any) => ({
                role: String(message?.role || ''),
                content: String(message?.conteudo || ''),
            }));
        const contextualReplyKind = detectContextualReplyKind(normalizedQuery, history);

        if (
            currentCourseInterest
            && contextualReplyKind === 'city'
            && !looksLikeCourseContextFollowupQuery(normalizedQuery)
            && looksLikeLikelyCityReply(normalizedQuery)
        ) {
            return {
                items: [],
                total: 0,
                raw_total: 0,
                tipo_busca: 'contextual_reply_guard',
                lookup_mode: 'blocked_contextual_city_reply',
                match_status: 'skipped',
                catalog_intent: false,
                resolver_branch: 'blocked_contextual_city_reply',
                catalog_query_type: 'blocked_contextual_city_reply',
                matched_courses: currentCourseInterest ? [currentCourseInterest] : [],
                listed_courses: [],
                listed_areas: [],
                available_areas: [],
                raw_inbound: args.query,
                normalized_inbound: normalizedQuery,
                query_processada: normalizedQuery,
                effective_query: currentCourseInterest,
                fallback_query: null,
                query_context_mode: 'blocked_city_reply',
                candidates_considered: [],
                nota: currentCity
                    ? 'Consulta ignorada porque a mensagem parece resposta curta de cidade e o curso atual ja estava confirmado.'
                    : 'Consulta ignorada porque a mensagem parece resposta curta de cidade e o curso atual ja estava confirmado.',
            };
        }

        const useCurrentCourseContext = Boolean(currentCourseInterest)
            && looksLikeCourseContextFollowupQuery(normalizedQuery);
        const effectiveQuery = useCurrentCourseContext ? currentCourseInterest : normalizedQuery;
        let lookupMode = String(args.lookup_mode_hint || '').trim() || detectCatalogLookupMode(effectiveQuery);
        const structuredEntries = await fetchStructuredCourseEntries(ctx);
        let matchedEntryForPersistence: any = null;

        let results: any[] = [];
        let courseCandidates: string[] = [];
        let matchedCourses: string[] = [];
        let listedCourses: string[] = [];
        let availableAreas: string[] = [];
        let matchStatus = 'not_found';
        const resultSource = 'structured_catalog_db';
        let requestedAreaSlug = '';
        let requestedAreaName = '';
        let relatedAreaCourses: string[] = [];
        let requestedAreaCandidate: string | null = null;
        let requestedAreaConfidence = 'none';
        let requestedAreaSource: string | null = null;
        let semanticAvailableAreas: string[] = [];

        if (structuredEntries.length > 0) {
            let specificResolution = resolveStructuredSpecificCourses(effectiveQuery, structuredEntries);
            if (
                lookupMode !== 'specific'
                && !hasBroadBrowseIntent(effectiveQuery)
                && ['found', 'ambiguous_found'].includes(String(specificResolution?.status || ''))
            ) {
                lookupMode = 'specific';
            }
            specificResolution = lookupMode === 'specific' ? specificResolution : null;
            const browseEntries = lookupMode === 'specific' || lookupMode === 'browse_catalog'
                ? []
                : browseStructuredCourses(effectiveQuery, structuredEntries);
            availableAreas = lookupMode === 'browse_catalog'
                ? listAvailableAreas(structuredEntries)
                : [];

            matchedCourses = (specificResolution?.matchedEntries || []).map((entry) => getCourseDisplayName(String(entry.display_name || '')));
            matchedEntryForPersistence = specificResolution?.matchedEntries?.[0] || null;
            listedCourses = lookupMode === 'specific'
                ? (specificResolution?.listedEntries || []).map((entry) => getCourseDisplayName(String(entry.display_name || '')))
                : lookupMode === 'browse_catalog'
                    ? []
                    : browseEntries.map((entry) => getCourseDisplayName(String(entry.display_name || '')));
            matchStatus = lookupMode === 'specific'
                ? (specificResolution?.status || 'not_found')
                : lookupMode === 'browse_catalog'
                    ? (availableAreas.length > 0 ? 'browse_areas_found' : 'browse_not_found')
                    : (listedCourses.length > 0 ? 'browse_found' : 'browse_not_found');
            courseCandidates = lookupMode === 'specific'
                ? (specificResolution?.candidates || [])
                : lookupMode === 'browse_catalog'
                    ? availableAreas
                    : browseEntries.map((entry) => getCourseDisplayName(String(entry.display_name || '')));

            const selectedEntries = lookupMode === 'specific'
                ? structuredEntries.filter((entry) =>
                    matchedCourses.includes(getCourseDisplayName(String(entry.display_name || '')))
                    || listedCourses.includes(getCourseDisplayName(String(entry.display_name || ''))))
                : browseEntries;

            results = selectedEntries.map((entry) => ({
                filename: entry.source_key,
                content: buildStructuredCourseLabel(entry),
                score: scoreStructuredCourseEntry(entry, effectiveQuery),
                fonte: 'structured_catalog_db',
                course: entry,
            }));

            const inferredArea = inferRequestedAreaFromQuery(effectiveQuery, structuredEntries);
            requestedAreaSlug = inferredArea.slug || String(specificResolution?.bestAreaSlug || '');
            requestedAreaName = inferredArea.name || String(specificResolution?.bestAreaName || '');
            relatedAreaCourses = listAreaCoursesBySlug(structuredEntries, requestedAreaSlug);

            if (lookupMode === 'specific' && matchStatus === 'not_found' && !requestedAreaName) {
                const semanticSegment = resolveRequestedSegment(effectiveQuery, structuredEntries);
                requestedAreaCandidate = semanticSegment.candidate;
                requestedAreaConfidence = semanticSegment.confidence;
                requestedAreaSource = semanticSegment.source;
                semanticAvailableAreas = semanticSegment.availableAreas;
                if (semanticSegment.slug && semanticSegment.name && ['high', 'medium'].includes(semanticSegment.confidence)) {
                    requestedAreaSlug = semanticSegment.slug;
                    requestedAreaName = semanticSegment.name;
                    relatedAreaCourses = listAreaCoursesBySlug(structuredEntries, requestedAreaSlug);
                }
            }

            if (lookupMode !== 'specific' && listedCourses.length > 0 && !requestedAreaName) {
                const firstBrowseEntry = browseEntries[0];
                requestedAreaSlug = String(firstBrowseEntry?.area_slug || '');
                requestedAreaName = String(firstBrowseEntry?.area_name || '');
                relatedAreaCourses = listAreaCoursesBySlug(structuredEntries, requestedAreaSlug);
            }
        }

        const preservedConfirmedCourse = useCurrentCourseContext
            && lookupMode === 'specific'
            && matchStatus === 'not_found'
            && currentCourseInterest;

        if (preservedConfirmedCourse) {
            matchStatus = 'found';
        }
        let finalMatchedCourses = preservedConfirmedCourse
            ? [currentCourseInterest]
            : matchedCourses;

        const availableCourseLines = listAvailableCourseLines(listedCourses.length > 0 ? listedCourses : finalMatchedCourses);

        if (lookupMode === 'specific' && matchStatus === 'ambiguous_found' && availableCourseLines.length === 1) {
            matchStatus = 'found';
            const resolvedLine = availableCourseLines[0];
            const resolvedCourse = [...listedCourses, ...finalMatchedCourses]
                .find((course) => normalizeLineFormation(extractAcademicLine(String(course || ''))) === resolvedLine);
            finalMatchedCourses = [resolvedCourse || listedCourses[0] || finalMatchedCourses[0] || effectiveQuery];
        }

        const normalizedCourseState = normalizeCourseStateFromLookup({
            lookupMode,
            matchStatus,
            requestedAreaSlug,
            requestedAreaName,
            relatedAreaCourses,
        });

        if (lookupMode === 'specific' && matchStatus === 'found') {
            const degreeLevel = String(matchedEntryForPersistence?.degree_level || '').trim();
            const deliveryMode = String(matchedEntryForPersistence?.delivery_mode || '').trim();
            const { data: currentLead } = await ctx.supabase
                .from('leads')
                .select('sales_context')
                .eq('id', ctx.leadId)
                .maybeSingle();

            await ctx.supabase
                .from('leads')
                .update({
                    curso_interesse: String(matchedEntryForPersistence?.display_name || finalMatchedCourses[0] || effectiveQuery || '').trim() || null,
                    modalidade: isAllowedDeliveryMode(deliveryMode) ? deliveryMode : null,
                    sales_context: {
                        ...(currentLead?.sales_context || {}),
                        course_validated: true,
                        course_status: normalizedCourseState.course_status,
                        requested_course: effectiveQuery,
                        catalog_mode: 'inactive',
                        catalog_exploration_intent: false,
                        course_display_name: getCourseDisplayName(String(matchedEntryForPersistence?.display_name || finalMatchedCourses[0] || '')) || null,
                        line_selection_required: false,
                        linha_formacao: normalizeLineFormation(degreeLevel),
                        available_course_lines: availableCourseLines,
                        curso_base_nome: normalizeBaseCourseName(finalMatchedCourses[0] || ''),
                        modalidade_oferta: deliveryMode || null,
                        available_catalog_areas: [],
                        requested_area_slug: normalizedCourseState.requested_area_slug,
                        requested_area_name: normalizedCourseState.requested_area_name,
                        requested_area_candidate: requestedAreaCandidate,
                        requested_area_confidence: requestedAreaConfidence,
                        requested_area_source: requestedAreaSource,
                        related_area_courses: normalizedCourseState.related_area_courses,
                    },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', ctx.leadId);
        } else if (lookupMode === 'specific' && matchStatus === 'ambiguous_found') {
            const { data: currentLead } = await ctx.supabase
                .from('leads')
                .select('sales_context')
                .eq('id', ctx.leadId)
                .maybeSingle();

            await ctx.supabase
                .from('leads')
                .update({
                    curso_interesse: String((specificResolution?.listedEntries || [])[0]?.display_name || listedCourses[0] || effectiveQuery || '').trim() || null,
                    sales_context: {
                        ...(currentLead?.sales_context || {}),
                        course_validated: false,
                        course_status: normalizedCourseState.course_status,
                        catalog_mode: 'inactive',
                        catalog_exploration_intent: false,
                        course_display_name: getCourseDisplayName(String((specificResolution?.listedEntries || [])[0]?.display_name || listedCourses[0] || '')) || null,
                        line_selection_required: true,
                        linha_formacao: null,
                        available_course_lines: availableCourseLines,
                        curso_base_nome: normalizeBaseCourseName(listedCourses[0] || effectiveQuery),
                        available_catalog_areas: [],
                        requested_area_slug: normalizedCourseState.requested_area_slug,
                        requested_area_name: normalizedCourseState.requested_area_name,
                        related_area_courses: normalizedCourseState.related_area_courses,
                    },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', ctx.leadId);
        } else if (lookupMode === 'specific' && matchStatus === 'not_found') {
            const { data: currentLead } = await ctx.supabase
                .from('leads')
                .select('sales_context')
                .eq('id', ctx.leadId)
                .maybeSingle();

            await ctx.supabase
                .from('leads')
                .update({
                    sales_context: {
                        ...(currentLead?.sales_context || {}),
                        course_validated: false,
                        course_status: normalizedCourseState.course_status,
                        requested_course: effectiveQuery,
                        catalog_mode: 'inactive',
                        catalog_exploration_intent: false,
                        line_selection_required: false,
                        available_course_lines: [],
                        available_catalog_areas: [],
                        requested_area_slug: normalizedCourseState.requested_area_slug,
                        requested_area_name: normalizedCourseState.requested_area_name,
                        requested_area_candidate: requestedAreaCandidate,
                        requested_area_confidence: requestedAreaConfidence,
                        requested_area_source: requestedAreaSource,
                        related_area_courses: normalizedCourseState.related_area_courses,
                    },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', ctx.leadId);
        } else if (lookupMode !== 'specific') {
            const { data: currentLead } = await ctx.supabase
                .from('leads')
                .select('sales_context')
                .eq('id', ctx.leadId)
                .maybeSingle();

            await ctx.supabase
                .from('leads')
                .update({
                    sales_context: {
                        ...(currentLead?.sales_context || {}),
                        course_validated: false,
                        course_status: normalizedCourseState.course_status,
                        catalog_mode: lookupMode === 'browse_catalog'
                            ? 'awaiting_area'
                            : normalizedCourseState.course_status === 'catalog_area_selected'
                                ? 'awaiting_course'
                                : 'inactive',
                        catalog_exploration_intent: lookupMode === 'browse_catalog' || normalizedCourseState.course_status === 'catalog_area_selected',
                        available_course_lines: [],
                        available_catalog_areas: availableAreas,
                        requested_area_slug: normalizedCourseState.requested_area_slug,
                        requested_area_name: normalizedCourseState.requested_area_name,
                        related_area_courses: normalizedCourseState.related_area_courses,
                    },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', ctx.leadId);
        }

        return {
            items: results.map((item: any) => ({
                tipo: 'course',
                nome: item.course?.display_name || item.filename,
                arquivo: item.filename,
                trecho: item.content,
                area: item.course?.area_name || null,
                modalidade: item.course?.delivery_mode || null,
                duracao: item.course?.duration_text || null,
                grau: item.course?.degree_level || null,
                score: item.score,
                fonte: item.fonte || resultSource,
            })),
            total: lookupMode === 'specific'
                ? finalMatchedCourses.length
                : lookupMode === 'browse_catalog'
                    ? availableAreas.length
                    : listedCourses.length,
            raw_total: results.length,
            tipo_busca: 'structured_course_catalog',
            lookup_mode: lookupMode,
            match_status: matchStatus,
            catalog_intent: lookupMode === 'browse_catalog',
            resolver_branch: lookupMode === 'specific'
                ? `specific_${matchStatus}`
                : lookupMode === 'browse_catalog'
                    ? (availableAreas.length > 0 ? 'browse_catalog_areas_found' : 'browse_catalog_areas_not_found')
                    : (listedCourses.length > 0 ? 'browse_filter_or_area_found' : 'browse_filter_or_area_not_found'),
            catalog_query_type: lookupMode,
            matched_courses: finalMatchedCourses,
            listed_courses: listedCourses,
            listed_areas: lookupMode === 'browse_catalog' ? availableAreas : [],
            available_areas: availableAreas,
            raw_inbound: args.query,
            normalized_inbound: normalizedQuery,
            query_processada: normalizedQuery,
            effective_query: effectiveQuery,
            fallback_query: null,
            query_context_mode: useCurrentCourseContext ? 'current_course_context' : 'direct_query',
            requested_area_slug: requestedAreaSlug || null,
            requested_area: requestedAreaName || null,
            requested_course: lookupMode === 'specific' ? effectiveQuery : null,
            available_catalog_areas: semanticAvailableAreas.length > 0 ? semanticAvailableAreas : listAvailableAreas(structuredEntries),
            requested_area_candidate: requestedAreaCandidate,
            requested_area_confidence: requestedAreaConfidence,
            requested_area_source: requestedAreaSource,
            related_area_courses_count: relatedAreaCourses.length,
            course_status_final: normalizedCourseState.course_status,
            available_course_lines: availableCourseLines,
            related_area_courses: relatedAreaCourses,
            candidates_considered: courseCandidates.slice(0, 24),
            nota: lookupMode === 'specific'
                ? (
                    matchStatus === 'found'
                        ? (preservedConfirmedCourse
                            ? 'Curso mantido pelo contexto ja confirmado do lead.'
                            : 'Curso confirmado no catalogo estruturado oficial.')
                        : 'Nenhum curso com match real foi localizado no catalogo estruturado oficial para esta busca.'
                )
                : (
                    listedCourses.length > 0
                        ? 'Filtro de catalogo localizado com cursos disponiveis no catalogo estruturado.'
                        : 'Nenhum curso foi localizado para este filtro no catalogo estruturado oficial.'
                ),
        };
    }

    const items = await queryKnowledgeBase({
        supabase: ctx.supabase,
        tenantId: ctx.tenantId,
        type: args.tipo,
        query: args.query,
        limit: args.query ? 12 : 50,
    });

    return {
        items: items.map((item: any) => ({
            tipo: item.type,
            nome: item.label,
            ...item.value,
            fonte: 'supabase_publicada',
            score: item.score,
        })),
        total: items.length,
        tipo_busca: args.query ? 'ranked_supabase' : 'catalogo_publicado',
        nota: items.length > 0
            ? 'Resultados encontrados na base publicada do Supabase.'
            : 'Nenhum item publicado encontrado para esta busca no Supabase.',
    };
}

export const tool_consultar_conhecimento_unificado = tool_consultar_conhecimento;

export async function tool_notificar_admin(
    ctx: ToolContext,
    args: { motivo: string; detalhes?: string },
) {
    const telefoneAdmin = ctx.env.ADMIN_PHONE || '';
    if (!telefoneAdmin) {
        console.warn('[tools] telefone_admin nao configurado no tenant');
        return { ok: false, aviso: 'Admin phone not configured' };
    }

    const { data: lead } = await ctx.supabase
        .from('leads')
        .select('nome, telefone, etapa_atual, curso_interesse')
        .eq('id', ctx.leadId)
        .single();

    const nomesMotivo: Record<string, string> = {
        lead_perguntou_valor_antes_etapa: 'Lead perguntou valor antes da hora',
        lead_pronto_matricula: 'Lead pronto para matricula',
        matricula_confirmada: 'Matricula confirmada',
        lead_pediu_desconto: 'Lead pediu desconto',
        restricao_financeira: 'Restricao financeira',
        nao_sei_responder: 'Agente nao soube responder',
    };

    const texto = `Alerta interno: ${nomesMotivo[args.motivo] || args.motivo}\n\n` +
        `Lead: ${lead?.nome || 'desconhecido'}\n` +
        `Tel: ${lead?.telefone || ctx.telefone}\n` +
        `Etapa: ${lead?.etapa_atual || '?'}\n` +
        `Curso: ${lead?.curso_interesse || '?'}\n` +
        (args.detalhes ? `\nDetalhes: ${args.detalhes}` : '');

    try {
        const senderUrl = `${ctx.env.SUPABASE_URL}/functions/v1/whatsapp-sender`;
        const res = await fetch(senderUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY || ''}`,
            },
            body: JSON.stringify({
                lead_id: ctx.leadId,
                telefone: telefoneAdmin,
                text: texto,
                skip_governance: true,
            }),
        });
        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            console.error(`[tools] notificar_admin erro: ${errBody}`);
            return { ok: false, error: errBody };
        }
        return { ok: true, motivo: args.motivo };
    } catch (e) {
        console.error(`[tools] notificar_admin exception: ${e}`);
        return { ok: false, error: String(e) };
    }
}

export const TOOL_IMPL = {
    ler_lead: tool_ler_lead,
    atualizar_lead: tool_atualizar_lead,
    avancar_etapa: tool_avancar_etapa,
    registrar_matricula: tool_registrar_matricula,
    registrar_indicacao: tool_registrar_indicacao,
    acionar_handoff: tool_acionar_handoff,
    consultar_conhecimento: tool_consultar_conhecimento_unificado,
    notificar_admin: tool_notificar_admin,
};
