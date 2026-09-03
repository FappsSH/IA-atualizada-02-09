import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return '-';
  return new Date(date).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTime(date: string | Date | null | undefined): string {
  if (!date) return '-';
  return new Date(date).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(date: string | Date | null | undefined): string {
  if (!date) return '-';
  const now = new Date();
  const d = new Date(date);
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHor = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'agora';
  if (diffMin < 60) return `${diffMin}min`;
  if (diffHor < 24) return `${diffHor}h`;
  if (diffDay < 30) return `${diffDay}d`;
  return formatDate(date);
}

export function getStageColor(stage: string): string {
  const colors: Record<string, string> = {
    E1: 'bg-stage-E1',
    E2: 'bg-stage-E2',
    E3: 'bg-stage-E3',
    E4: 'bg-stage-E4',
    E5: 'bg-stage-E5',
    E6: 'bg-stage-E6',
    E7: 'bg-stage-E7',
    handoff: 'bg-stage-handoff',
    encerrado: 'bg-stage-encerrado',
    inativo: 'bg-gray-400',
  };
  return colors[stage] || 'bg-gray-500';
}

export function getStageLabel(stage: string): string {
  const labels: Record<string, string> = {
    E1: 'Conexão',
    E2: 'Profunda',
    E3: 'Produto',
    E4: 'Financeiro',
    E5: 'Validação',
    E6: 'Indicações',
    E7: 'Preparar',
    handoff: 'Handoff',
    encerrado: 'Encerrado',
    inativo: 'Inativo',
  };
  return labels[stage] || stage;
}

export function getStageBadgeColor(stage: string): string {
  const colors: Record<string, string> = {
    E1: 'bg-slate-500',
    E2: 'bg-blue-500',
    E3: 'bg-violet-500',
    E4: 'bg-orange-500',
    E5: 'bg-green-500',
    E6: 'bg-teal-500',
    E7: 'bg-cyan-500',
    handoff: 'bg-red-500',
    encerrado: 'bg-gray-500',
    inativo: 'bg-gray-400',
  };
  return colors[stage] || 'bg-gray-500';
}

export function getTemperatureBadgeColor(temperature?: string | null): string {
  const colors: Record<string, string> = {
    cold: 'bg-slate-500',
    warm: 'bg-amber-500',
    hot: 'bg-rose-500',
  };
  return colors[temperature || ''] || 'bg-gray-400';
}

export function getTemperatureLabel(temperature?: string | null): string {
  const labels: Record<string, string> = {
    cold: 'Frio',
    warm: 'Morno',
    hot: 'Quente',
  };
  return labels[temperature || ''] || 'Sem leitura';
}

export function getIntentLabel(intent?: string | null): string {
  const labels: Record<string, string> = {
    greeting: 'Abertura',
    question: 'Pergunta',
    qualification: 'Qualificacao',
    objection: 'Objecao',
    price: 'Preco',
    proposal: 'Proposta',
    enrollment: 'Matricula',
    human_help: 'Ajuda humana',
    followup: 'Follow-up',
    other: 'Outro',
  };
  return labels[intent || ''] || 'Nao identificado';
}

export function getBuyingStageLabel(stage?: string | null): string {
  const labels: Record<string, string> = {
    cold: 'Frio',
    aware: 'Ciente',
    considering: 'Considerando',
    proposal: 'Em proposta',
    decision: 'Decisao',
  };
  return labels[stage || ''] || 'Sem leitura';
}

export function getUrgencyLabel(urgency?: string | null): string {
  const labels: Record<string, string> = {
    low: 'Baixa',
    medium: 'Media',
    high: 'Alta',
  };
  return labels[urgency || ''] || 'Nao definida';
}

export function getObjectionLabel(objection?: string | null): string {
  const labels: Record<string, string> = {
    none: 'Sem objecao',
    price: 'Preco',
    time: 'Tempo',
    trust: 'Confianca',
    bureaucracy: 'Burocracia',
    other: 'Outra',
  };
  return labels[objection || ''] || 'Nao identificada';
}

export function getNextBestActionLabel(action?: string | null): string {
  const labels: Record<string, string> = {
    qualify: 'Qualificar melhor',
    answer_question: 'Responder pergunta',
    handle_objection: 'Tratar objecao',
    present_offer: 'Apresentar oferta',
    send_proposal: 'Enviar proposta',
    ask_for_payment: 'Pedir pagamento',
    confirm_enrollment: 'Confirmar matricula',
    handoff: 'Fazer handoff',
  };
  return labels[action || ''] || 'Sem proximo passo';
}
