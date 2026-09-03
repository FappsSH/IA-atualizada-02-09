# AgentHub — Fapps

Assistente de vendas inteligente via WhatsApp com agentes de IA autônomos e pipeline comercial de 7 estágios. A plataforma gerencia leads desde o primeiro contato até a matrícula, com follow-ups automáticos, notificações ao admin e dashboard completo de monitoramento.

---

## Arquitetura

```
WhatsApp Lead
     ↓
Evolution API  (gateway self-hosted)
     ↓
Webhook Receiver  (Edge Function)
     ↓
PGMQ Queue  (message debounce)
     ↓
Debounce Worker  (consolida mensagens em 3s)
     ↓
AI Processor  (roteia por estágio → subagente)
     ↓
OpenAI GPT-4.1-mini  (agente + tools)
     ↓
Whatsapp Sender  (envia resposta)
     ↓
Evolution API
     ↓
Lead no WhatsApp
```

Follow-ups programados rodam via **pg_cron** a cada 15 minutos pelo `followup-worker`, respeitando horário comercial.

---

## Stack

| Tecnologia | Versão | Função |
|---|---|---|
| Next.js | 14.2 | Dashboard (App Router) |
| React | 18.3 | UI |
| TypeScript | ~5 | Linguagem |
| Supabase | — | Banco + Edge Functions + pgmq + pg_cron |
| OpenAI | GPT-4.1-mini | Agente conversacional |
| Evolution API | — | Gateway WhatsApp |
| Tailwind CSS | 3.4 | Estilização |
| shadcn/ui | — | Componentes (Radix) |
| recharts | 3.8 | Gráficos |
| Vitest | 4.0 | Testes |

---

## Pipeline de Vendas

| Estágio | Nome | Objetivo |
|---|---|---|
| E1 | Conexão e Qualificação | Coletar nome, cidade, curso de interesse, dor principal |
| E2 | Vacinas e D.I. | Esclarecer dúvidas sobre vacinas e documentação |
| E3 | Apresentação | Apresentar o curso escolhido |
| E4 | Fechamento Financeiro | Valor, parcelas, condições de pagamento |
| E5 | Validação Matrícula | Confirmar pagamento e registrar matrícula |
| E6 | Indicações | Solicitar indicações do lead |
| E7 | Preparar Indicados | Preparar contato com os indicados |

Cada estágio possui um **subagente** dedicado com prompt específico e ferramentas próprias. Os prompts podem ser customizados via dashboard em `/subagentes`.

---

## Estrutura do Projeto

```
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── page.tsx                  # Dashboard principal
│   │   ├── prospeccao/               # Prospecção ativa
│   │   ├── conversas/                # Conversas em tempo real
│   │   ├── conhecimento/             # Base de conhecimento
│   │   ├── followups/                # Gerenciamento de follow-ups
│   │   ├── subagentes/               # Editor de prompts dos agentes
│   │   └── configuracoes/            # Configurações do sistema
│   ├── components/                   # Componentes compartilhados
│   ├── hooks/                        # React hooks
│   └── lib/                          # Utilitários, tipos, client Supabase
│
├── supabase/
│   ├── functions/                    # Edge Functions (Deno)
│   │   ├── webhook-receiver/         # Recebe mensagens do WhatsApp
│   │   ├── debounce-worker/          # Consolida mensagens
│   │   ├── ai-processor/             # Processa com IA (subagentes)
│   │   ├── followup-worker/          # Dispara follow-ups
│   │   ├── whatsapp-sender/          # Envia mensagens via Evolution API
│   │   └── _shared/                  # Módulos compartilhados
│   └── migrations/                   # 9 migrações do banco
│
├── tests/                            # Testes unitários
├── scripts/                          # Scripts auxiliares
└── package.json
```

---

## Começando

### Pré-requisitos

- Node.js 20+
- Supabase CLI (`npm install -g supabase`)
- Conta OpenAI com API Key
- Instância Evolution API rodando

### Setup local

```bash
# Clone e instale dependências
npm install

# Configure variáveis de ambiente
cp .env.local.example .env.local
# Edite .env.local com suas credenciais

# Vincule ao projeto Supabase remoto
supabase link

# Aplique as migrações
npm run db:push

# Deploy das Edge Functions
supabase functions deploy webhook-receiver
supabase functions deploy debounce-worker
supabase functions deploy ai-processor
supabase functions deploy followup-worker
supabase functions deploy whatsapp-sender

# Inicie o dashboard local
npm run dev
```

### Ou deploy completo via script

```bash
bash scripts/deploy.sh
```

---

## Variáveis de Ambiente

| Variável | Onde usar | Descrição |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Frontend | URL do projeto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Frontend | Chave anônima Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Funções + Scripts | Chave service_role (admin) |
| `NEXT_PUBLIC_SUPABASE_FUNCTIONS_URL` | Frontend | URL base das Edge Functions |

As chaves sensíveis (OpenAI, Evolution API) são configuradas no **Supabase Vault** ou via Dashboard em `/configuracoes`, onde ficam armazenadas no `tenants.config` (coluna JSONB).

---

## Scripts

| Comando | Descrição |
|---|---|
| `npm run dev` | Dashboard local |
| `npm run build` | Build de produção |
| `npm run test` | Rodar todos os testes |
| `npm run test:supabase:unit` | Testes unitários das funções |
| `npm run db:push` | Deploy migrations |
| `npm run db:status` | Status do banco remoto |

---

## Testes

Testes unitários com Vitest cobrindo:
- Schemas das tools (`tool-schemas.test.ts`)
- Roteamento por estágio (`router.test.ts`)
- Detector de loops (`loop-detector.test.ts`)
- Guardião de confirmação (`confirmation-guard.test.ts`)
- Lista de permissão de subagentes (`subagent-allowlist.test.ts`)
- Sanitização de PII (`redact-pii.test.ts`)

```bash
npm run test:supabase:unit
```

---

## Licença

ISC — Fapps
"# IA-atualizada-02-09" 
