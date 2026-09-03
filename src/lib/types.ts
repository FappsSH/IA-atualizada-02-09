export interface Lead {
  id: string;
  tenant_id: string;
  telefone: string;
  nome: string | null;
  cidade?: string | null;
  curso_interesse: string;
  modalidade?: string | null;
  dor_principal: 'tempo' | 'dinheiro' | 'ambos' | null;
  etapa_atual: Stage;
  matriculado: boolean;
  bloqueado: boolean;
  valor_parcela: number | null;
  valor_matricula?: number | null;
  matricula_em?: string | null;
  created_at: string;
  updated_at: string;
  ultimo_contato_em: string | null;
  handoff_em: string | null;
  decisor_confirmado: boolean;
  viagem_programada: boolean;
  proposta_enviada_em?: string | null;
  pronto_matricula_em?: string | null;
  ultima_classificacao_em?: string | null;
  ultimo_resumo_ia?: string | null;
  sales_context?: SalesContext;
}

export type Stage = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'handoff' | 'encerrado' | 'inativo' | 'PERSONALITY';

export interface Mensagem {
  id: string;
  lead_id: string;
  role: 'user' | 'assistant' | 'system';
  conteudo: string;
  etapa_no_momento: string;
  subagente_usado: string | null;
  tool_calls: ToolCall[] | null;
  iteracoes: number | null;
  tokens_usados: number | null;
  created_at: string;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}

export interface AgentDefinition {
  id: string;
  tenant_id: string;
  subagent_key: Stage;
  enabled: boolean;
  config: AgentConfig;
  prompt_override: string | null;
  prompt_updated_at: string | null;
  updated_at: string;
}

export interface AgentConfig {
  nome: string;
  objetivo: string;
  default_prompt?: string;
}

export const AGENT_NAMES: Record<string, string> = {
  E1: 'Conexão e Qualificação',
  E2: 'Qualificacao Profunda',
  E3: 'Apresentação do Produto',
  E4: 'Fechamento Financeiro',
  E5: 'Validação e Matrícula',
  E6: 'Pegar Indicações',
  E7: 'Preparar Indicados',
  handoff: 'Handoff Humano',
  encerrado: 'Encerrado',
  inativo: 'Inativo',
  PERSONALITY: 'Personalidade Compartilhada',
};

export const AGENT_OBJECTIVES: Record<string, string> = {
  E1: 'Conectar com o lead, descobrir a dor principal e qualificar o interesse',
  E2: 'Aprofundar o contexto do lead, antecipar objecoes e preparar a progressao comercial',
  E3: 'Apresentar o produto/serviço de forma personalizada',
  E4: 'Negociar condições de pagamento e fechar financeiro',
  E5: 'Validar dados e confirmar matrícula',
  E6: 'Solicitar indicações de amigos/familiares',
  E7: 'Preparar os indicados para receberem contato',
  handoff: 'Atendimento humano',
  encerrado: 'Lead encerrado',
  inativo: 'Lead inativo',
  PERSONALITY: 'Define quem o agente é e como se comunica em todas as etapas',
};

export interface Indicacao {
  id: string;
  lead_origem_id: string;
  telefone_indicado: string;
  nome_indicado: string | null;
  status: string;
  created_at: string;
}

export interface TraceSpan {
  id: string;
  service: string;
  span_name: string;
  tenant_id: string;
  conversation_id: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  status: 'ok' | 'warning' | 'error';
  duration_ms: number | null;
  created_at: string;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  config: TenantConfig;
}

export interface SalesContext {
  intent?: SalesIntent;
  buying_stage?: BuyingStage;
  temperature?: LeadTemperature;
  primary_objection?: LeadObjection;
  urgency?: LeadUrgency;
  next_best_action?: NextBestAction;
  confidence?: number;
  summary?: string;
  needs_handoff?: boolean;
  asked_price_early?: boolean;
  asked_discount?: boolean;
  payment_confirmed?: boolean;
  proposal_ready?: boolean;
  enrollment_ready?: boolean;
  last_user_message?: string;
  suggested_stage?: Stage | null;
  updated_at?: string;
  proposal_checkpoint_pending?: boolean;
  proposal_checkpoint_completed?: boolean;
  enrollment_checkpoint_pending?: boolean;
  enrollment_checkpoint_completed?: boolean;
  course_validated?: boolean;
  line_selection_required?: boolean;
  linha_formacao?: string | null;
  curso_base_nome?: string | null;
  modalidade_oferta?: string | null;
  motivacao_principal?: string | null;
  payment_declared?: boolean;
  pending_indication_name?: string | null;
  last_indicated_name?: string | null;
  boleto_date_choice?: string | null;
  boleto_date_label?: string | null;
  no_indication?: boolean;
}

export type SalesIntent =
  | 'greeting'
  | 'question'
  | 'qualification'
  | 'objection'
  | 'price'
  | 'proposal'
  | 'enrollment'
  | 'human_help'
  | 'followup'
  | 'other';

export type BuyingStage = 'cold' | 'aware' | 'considering' | 'proposal' | 'decision';
export type LeadTemperature = 'cold' | 'warm' | 'hot';
export type LeadObjection = 'none' | 'price' | 'time' | 'trust' | 'bureaucracy' | 'other';
export type LeadUrgency = 'low' | 'medium' | 'high';
export type NextBestAction =
  | 'qualify'
  | 'answer_question'
  | 'handle_objection'
  | 'present_offer'
  | 'send_proposal'
  | 'ask_for_payment'
  | 'confirm_enrollment'
  | 'handoff';

export interface TenantConfig {
  modelo_ia?: string;
  temperatura?: number;
  business_hours?: BusinessHours;
  canal?: string;
  evolution_api_url?: string;
  evolution_api_key?: string;
  evolution_instance_name?: string;
  openai_api_key?: string;
  openai_vector_store_id?: string;
  telefone_admin?: string;
  max_iteracoes_subagente?: number;
  message_policy?: MessagePolicy;
}

export interface MessagePolicy {
  general_rules?: string;
  greeting_rules?: {
    morning?: GreetingRule;
    afternoon?: GreetingRule;
    night?: GreetingRule;
  };
  formatting?: {
    force_separate_messages?: boolean;
    insert_blank_line_in_long_messages?: boolean;
    long_message_char_threshold?: number;
    sentences_per_block?: number;
    example_message_1?: string;
    example_message_2?: string;
  };
  forbidden_chars?: string;
}

export interface GreetingRule {
  start?: string;
  end?: string;
  text?: string;
}

export interface BusinessHours {
  start?: string;
  end?: string;
  tz?: string;
  inicio?: string;
  fim?: string;
  fuso?: string;
}

export interface WhatsAppInstance {
  id: string;
  tenant_id?: string;
  instance_name: string;
  numero: string | null;
  status: 'conectado' | 'desconectado' | 'conectando' | 'banido';
  provider?: string;
  config?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface KnowledgeItem {
  id: string;
  tenant_id: string;
  type: 'course' | 'link' | 'general' | 'faq' | 'pricing_rule' | 'offer' | 'policy' | 'script' | 'objection_playbook';
  key: string;
  label: string;
  value: Record<string, any>;
  active: boolean;
  status?: 'draft' | 'published' | 'archived';
  searchable_text?: string;
  tags?: string[];
  published_at?: string | null;
  consult_count?: number;
  last_consulted_at?: string | null;
  last_consulted_source?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ErrorCodeEntry {
  code: string;
  description: string;
  where: string;
  howToFix: string;
  occurrences: number;
  lastOccurrence: string | null;
}

export interface FollowupConfig {
  id: string;
  tenant_id: string;
  attempt: number;
  interval_minutes: number;
  label: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface FollowupSchedule {
  id: string;
  lead_id: string;
  tenant_id: string;
  attempt: number;
  max_attempts: number;
  schedule_at: string;
  trigger_reason: string | null;
  last_context: Record<string, unknown> | null;
  sent_messages: { text: string; attempt: number; sent_at?: string }[];
  status: 'pending' | 'sent' | 'cancelled' | 'expired';
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  leads?: Pick<Lead, 'id' | 'nome' | 'telefone' | 'etapa_atual' | 'curso_interesse'> | null;
}

export interface FollowupLog {
  id: string;
  tenant_id: string;
  lead_id: string | null;
  schedule_id: string | null;
  attempt: number | null;
  status: string;
  error_message: string | null;
  lead_etapa: string | null;
  created_at: string;
}
