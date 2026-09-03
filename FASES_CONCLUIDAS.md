# Fases Concluidas

## Fase 1 - Fundacao Operacional e Sincronizacao Base

### Objetivo
Estabilizar a comunicacao entre dashboard, banco e agentes, transformando o `tenants.config` na fonte real de configuracao operacional e removendo os principais gargalos de sincronizacao do sistema.

### Como estava antes
- O dashboard dependia de `/api/supabase`, mas essa rota nao existia no projeto.
- Varias telas usavam polling e nao sincronizavam mudancas em tempo real.
- O painel salvava configuracoes em `tenants.config`, mas as Edge Functions principais continuavam lendo `Deno.env` quase sempre.
- O `ai-processor` nao aceitava execucao direta para prospeccao ativa; ele so consumia mensagens da fila.
- O worker de follow-up usava o estado `inativo`, mas esse estado nao era aceito no schema principal dos leads.
- O painel de configuracoes nao controlava todos os campos operacionais necessarios, como `telefone_admin` e `evolution_instance_name`.

### Como esta agora
- A rota [src/app/api/supabase/route.ts](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/src/app/api/supabase/route.ts) foi criada e passou a suportar `select`, `insert`, `update` e `count` para as tabelas usadas pelo dashboard.
- Foi criada uma camada compartilhada de configuracao runtime em [supabase/functions/_shared/runtime-config.ts](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/supabase/functions/_shared/runtime-config.ts), tornando `tenants.config` a fonte primaria com fallback para `env`.
- `ai-processor`, `webhook-receiver`, `whatsapp-sender` e `followup-worker` passaram a ler modelo, temperatura, iteracoes, OpenAI, Evolution e telefone do admin a partir da configuracao do tenant.
- O `ai-processor` agora tambem aceita execucao direta por `POST`, destravando o fluxo de prospeccao ativa iniciado pelo dashboard.
- O dashboard ganhou sincronizacao em tempo real em areas centrais:
  - conversas e leads
  - conhecimento
  - follow-ups
  - configuracoes
  - cabecalho/status do WhatsApp
  - overview da dashboard com refresh reativo
- O painel de configuracoes agora expone e salva:
  - `gpt-4.1`
  - `evolution_instance_name`
  - `telefone_admin`
- O estado `inativo` foi alinhado entre codigo e banco por meio da migration [supabase/migrations/20260010_phase1_sync.sql](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/supabase/migrations/20260010_phase1_sync.sql).

### Principais entregas tecnicas
- Camada de dados do dashboard funcional.
- Configuracao centralizada por tenant.
- Runtime coerente entre UI e Edge Functions.
- Realtime ampliado para os pontos criticos da operacao.
- Correcao estrutural do estado `inativo`.
- Base pronta para a Fase 2, sem depender de configuracoes "fantasma".

### Validacao
- A validacao por `npm run test:supabase:unit` e `npm run build` nao pode ser concluida em 13 de agosto de 2026 porque o ambiente atual nao possui `node_modules` instalado.
- Evidencias encontradas:
  - `vitest` nao foi localizado
  - `next` nao foi localizado
- Essa limitacao e do ambiente local atual, nao de uma falha confirmada da implementacao.

### Observacao
Esta fase conclui a fundacao operacional. A partir daqui, as proximas fases podem evoluir o SDR com muito menos atrito, porque dashboard, configuracao e runtime deixaram de operar em caminhos separados.

## Fase 2 - Inteligencia Comercial do SDR

### Objetivo
Transformar o agente de um fluxo guiado quase apenas por prompt em um SDR com memoria comercial estruturada, leitura de intencao do lead e gatilhos deterministicos para momentos criticos de venda.

### Como estava antes
- O SDR dependia principalmente do prompt da etapa atual para decidir como conversar.
- O processo comercial existia, mas a leitura de intencao, temperatura, objecao e prontidao de compra nao era persistida de forma estruturada.
- O sistema nao mantinha uma memoria comercial reutilizavel entre interacoes, apenas historico textual e alguns campos basicos do lead.
- Gatilhos importantes como proposta, matricula e pedido explicito de humano dependiam demais do modelo chamar tools por conta propria.
- A dashboard nao mostrava um estado comercial claro do lead alem da etapa.

### Como esta agora
- A migration [supabase/migrations/20260011_sales_intelligence.sql](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/supabase/migrations/20260011_sales_intelligence.sql) adicionou memoria comercial ao lead com:
  - `sales_context`
  - `proposta_enviada_em`
  - `pronto_matricula_em`
  - `ultima_classificacao_em`
  - `ultimo_resumo_ia`
- Foi criada a tabela `lead_events` para registrar eventos criticos do funil e evitar notificacoes duplicadas em momentos deterministicos.
- Foi criado o classificador hibrido em [supabase/functions/ai-processor/intelligence.ts](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/supabase/functions/ai-processor/intelligence.ts), que combina:
  - sinais deterministicos
  - fallback heuristico
  - classificacao com LLM
- O `ai-processor` agora classifica cada nova mensagem e persiste:
  - intencao
  - estagio de compra
  - temperatura do lead
  - objecao principal
  - urgencia
  - proxima melhor acao
  - prontidao para proposta
  - prontidao para matricula
  - necessidade de handoff
  - resumo comercial
- Foram adicionados gatilhos deterministicos para:
  - lead perguntando preco antes da etapa financeira
  - lead em momento de proposta de valor
  - lead pronto para inscricao/matricula
  - handoff automatico quando o lead pede humano ou entra em negociacao especial/desconto
- O subagente passou a receber a memoria comercial estruturada no prompt, mantendo o processo E1-E7 como base, mas com muito mais contexto real de venda.
- A dashboard agora exibe sinais comerciais no atendimento:
  - temperatura do lead
  - proxima melhor acao
  - resumo comercial curto

### Principais entregas tecnicas
- Memoria comercial persistida no lead.
- Classificacao hibrida em tempo de processamento.
- Eventos comerciais com deduplicacao.
- Gatilhos deterministicos para proposta, matricula e handoff.
- Subagente orientado por contexto comercial real.
- Visibilidade operacional melhor na dashboard de conversas.

### Validacao
- Assim como na Fase 1, a validacao automatizada por build e testes ainda depende de instalar as dependencias do projeto, porque o ambiente atual continua sem `node_modules`.
- O codigo da Fase 2 foi integrado de ponta a ponta, mas a execucao automatizada ainda precisa dessa etapa do ambiente.

### Observacao
Esta fase conclui o nucleo de inteligencia comercial do SDR sem abandonar o processo definido. O funil continua sendo a base, mas agora o agente enxerga o estado real da venda, registra isso e reage de forma mais previsivel nos momentos criticos.

## Fase 3 - Base de Conhecimento Unificada

### Objetivo
Transformar `knowledge_items` na fonte unica de verdade do conhecimento do SDR, reduzindo a dependencia operacional de fontes paralelas e ampliando a capacidade do dashboard de publicar conteudo que o agente realmente consulta.

### Como estava antes
- A base de conhecimento era hibrida e fragil:
  - cursos dependiam de um `VECTOR_STORE_ID` hardcoded
  - links e alguns dados vinham do Supabase
- O dashboard de conhecimento gerenciava basicamente cursos e links, mas nao uma base institucional mais ampla.
- Nao havia um modelo consistente de publicacao, busca e expansao do catalogo de itens institucionais.
- O agente podia acabar operando com dados que nao eram exatamente os mesmos do painel.

### Como esta agora
- A migration [supabase/migrations/20260012_knowledge_unification.sql](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/supabase/migrations/20260012_knowledge_unification.sql) expandiu `knowledge_items` com:
  - `status`
  - `searchable_text`
  - `tags`
  - `published_at`
- O modelo da base passou a suportar mais tipos institucionais:
  - `course`
  - `link`
  - `general`
  - `faq`
  - `pricing_rule`
  - `offer`
  - `policy`
  - `script`
  - `objection_playbook`
- Foi criada a camada [supabase/functions/ai-processor/knowledge.ts](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/supabase/functions/ai-processor/knowledge.ts), que:
  - busca somente itens ativos e publicados
  - ranqueia resultados por proximidade textual
  - monta uma secao unificada de conhecimento para o prompt do agente
- O backend operacional da consulta de conhecimento foi redirecionado para a base publicada do Supabase, atraves do `TOOL_IMPL` da tool `consultar_conhecimento`.
- O `subagent` agora tambem injeta no prompt uma visao unificada da base publicada, reduzindo o desencontro entre dashboard e runtime.
- O dashboard de conhecimento passou a gerenciar tambem itens gerais e FAQ, com:
  - tipo do item
  - conteudo
  - tags
  - `searchable_text`
  - publicacao consistente

### Principais entregas tecnicas
- Base de conhecimento publicada e estruturada como catalogo unico.
- Busca ranqueada em `knowledge_items`.
- Ampliacao do modelo sem quebrar cursos e links existentes.
- Gestao de itens gerais e FAQ no painel.
- Prompt do agente enriquecido com base unificada publicada.

### Validacao
- Assim como nas fases anteriores, a validacao automatizada ainda depende da instalacao das dependencias do projeto no workspace atual.
- A implementacao ficou integrada ao fluxo do agente e ao dashboard, mas o ambiente ainda nao possui `node_modules` para build/teste local completo.

### Observacao
Esta fase consolida a base de conhecimento como ativo operacional do SDR. A partir daqui, ajustar conhecimento no painel passa a ter impacto muito mais direto e previsivel no comportamento do agente.

## Fase 4 - Dashboard Comercial e Operacao Assistida

### Objetivo
Transformar a dashboard e a central de conversas em uma camada real de operacao comercial, permitindo priorizar leads, identificar momentos de proposta e matricula e intervir com contexto completo quando necessario.

### Como estava antes
- A dashboard mostrava bem o volume operacional, mas ainda nao ajudava a priorizar fechamento.
- O sistema ja classificava temperatura, intencao e prontidao comercial, mas essas leituras ficavam subaproveitadas na operacao diaria.
- A central de conversas mostrava historico e controles de takeover, mas faltava uma leitura comercial consolidada ao lado da conversa.
- O gestor ainda precisava interpretar manualmente se um lead estava quente, pronto para proposta ou pronto para matricula.

### Como esta agora
- A dashboard principal em [src/app/page.tsx](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/src/app/page.tsx) passou a consultar e agregar sinais comerciais diretamente dos leads com `sales_context`.
- O client da dashboard em [src/app/DashboardClient.tsx](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/src/app/DashboardClient.tsx) ganhou sincronizacao reativa tambem para `lead_events` e passou a exibir novos indicadores de performance comercial:
  - `Leads Quentes`
  - `Prontos Proposta`
  - `Prontos Matricula`
- Foi criado o painel [src/components/dashboard/SalesIntelligencePanel.tsx](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/src/components/dashboard/SalesIntelligencePanel.tsx), que organiza a operacao em tres filas praticas:
  - leads quentes
  - leads prontos para proposta de valor
  - leads prontos para matricula
- A central de conversas passou a exibir um painel lateral de inteligencia comercial em [src/components/conversas/LeadIntelligencePanel.tsx](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/src/components/conversas/LeadIntelligencePanel.tsx), mostrando:
  - intencao
  - estagio de compra
  - urgencia
  - objecao principal
  - proximo passo recomendado
  - confianca da leitura
  - sinais de proposta, handoff e matricula
  - resumo comercial consolidado
- A janela de conversa em [src/components/conversas/ChatWindow.tsx](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/src/components/conversas/ChatWindow.tsx) foi reestruturada para operar em modo assistido, mantendo takeover e forca de etapa, mas agora com leitura comercial em paralelo.
- A camada utilitaria em [src/lib/utils.ts](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/src/lib/utils.ts) passou a traduzir os estados da inteligencia comercial para labels operacionais compreensiveis no painel.

### Principais entregas tecnicas
- Dashboard orientada por prioridade comercial, nao apenas por volume.
- Radar operacional para proposta e matricula.
- Painel lateral de inteligencia para atendimento humano assistido.
- Realtime ampliado para eventos comerciais relevantes.
- Melhor ponte entre classificacao da IA e tomada de decisao humana.

### Validacao
- A validacao automatizada completa continua dependente da instalacao de `node_modules` no workspace atual.
- Nesta data, 13 de agosto de 2026, a implementacao foi concluida no codigo, mas ainda nao foi possivel executar `build` local completo por falta das dependencias do projeto.

### Observacao
Esta fase conclui a primeira versao da camada de operacao comercial do SDR. A IA agora nao apenas conversa e classifica: ela tambem abastece uma dashboard pensada para acao, priorizacao e refinamento continuo da venda.

## Fase 5 - Otimizacao de Supabase e Runtime Comercial

### Objetivo
Reduzir latencia, custo e carga desnecessaria no runtime do SDR, consolidando o Supabase como base operacional principal e removendo gargalos que atrapalhavam escala, previsibilidade e manutencao.

### Como estava antes
- O `ai-processor` ainda carregava mais contexto do que precisava em algumas etapas.
- A camada de tools ainda mantinha legado de `VECTOR_STORE_ID` e busca antiga, mesmo depois da unificacao da base de conhecimento.
- O runtime fazia consultas redundantes para tenant e configuracao em pontos que ja tinham dados carregados.
- Os timestamps de proposta e prontidao de matricula podiam ser sobrescritos varias vezes, perdendo o primeiro momento real do evento.
- Faltavam alguns indices alinhados com as consultas mais quentes da dashboard e da operacao comercial.

### Como esta agora
- A implementacao de tools em [supabase/functions/ai-processor/tools.ts](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/supabase/functions/ai-processor/tools.ts) foi reestruturada para operar apenas com a base publicada do Supabase, removendo o caminho legado do vector store do fluxo principal.
- A busca em [supabase/functions/ai-processor/knowledge.ts](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/supabase/functions/ai-processor/knowledge.ts) agora:
  - filtra no banco antes de ranquear em memoria quando existe `query`
  - aceita `limit`
  - reduz o volume de itens que entram no prompt
  - corta descricoes longas para evitar inflar tokens sem ganho comercial
- O subagente em [supabase/functions/ai-processor/subagent.ts](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/supabase/functions/ai-processor/subagent.ts) passou a limitar explicitamente os itens de conhecimento carregados no prompt.
- O `ai-processor` em [supabase/functions/ai-processor/index.ts](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/supabase/functions/ai-processor/index.ts) deixou de repetir leituras desnecessarias de tenant para:
  - telefone do admin
  - horario comercial
- A persistencia de inteligencia em [supabase/functions/ai-processor/intelligence.ts](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/supabase/functions/ai-processor/intelligence.ts) agora preserva o primeiro marco de:
  - `proposta_enviada_em`
  - `pronto_matricula_em`
- Foi criada a migration [supabase/migrations/20260013_runtime_optimizations.sql](/C:/Users/fapps/Documents/Projetos/Agent%20Hub%20-%20Fapps/supabase/migrations/20260013_runtime_optimizations.sql), adicionando indices para:
  - leads por tenant e atualizacao
  - leads por tenant, etapa e atualizacao
  - pipeline ativa
  - knowledge items publicados
  - lead events por tenant e data
  - mensagens por lead e data

### Principais entregas tecnicas
- Remocao do legado de conhecimento fora do caminho principal do SDR.
- Menos roundtrips no `ai-processor`.
- Prompt mais enxuto e barato para o modelo.
- Melhor preservacao de eventos comerciais importantes.
- Indices mais aderentes ao uso real da dashboard e da fila operacional.

### Validacao
- Em 13 de agosto de 2026, `npm run build` passou com sucesso.
- Em 13 de agosto de 2026, `npm run test:supabase` passou com 42 de 42 testes.
- A migration foi criada no projeto e esta pronta para ser aplicada no ambiente alvo via fluxo de banco do time.

### Observacao
Esta fase fortalece o SDR para operacao real em volume maior. O sistema continua seguindo o processo comercial definido, mas agora com uma base muito mais preparada para escalar com menos latencia, menos custo e menos divergencia entre dashboard, runtime e conhecimento.
