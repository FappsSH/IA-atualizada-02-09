# MANUAL DE MANUTENCAO DO AGENTHUB

Este arquivo nao e mais um diagrama.

Agora ele serve como manual pratico para voce saber:
- onde mexer
- em qual arquivo mexer
- quando um problema esta em prompt, regra, conhecimento, fluxo, fila, envio ou banco
- quais arquivos estao ligados entre si

Objetivo:
- quando voce quiser melhorar ou corrigir algo, ja apontar o arquivo certo
- evitar pedir mudanca vaga sem saber onde a causa real esta

## Como pensar no projeto

O projeto tem 6 camadas principais:

1. Dashboard e telas
- onde voce edita prompts, regras, conhecimento e configuracoes

2. Banco e configuracao salva
- onde ficam `agent_definitions`, `tenants`, `knowledge_items`, `leads`, `mensagens`, `lead_events`

3. Entrada da mensagem
- webhook do WhatsApp recebe a mensagem e coloca na fila

4. Pipeline de fila
- debounce junta mensagens
- ai-processor decide qual agente responde

5. Runtime do subagente
- monta prompt real
- consulta conhecimento
- usa tools
- decide se avanca etapa

6. Saida
- whatsapp-sender envia a resposta

Se voce descobrir em qual camada o problema esta, quase sempre acha o arquivo certo.

## Mapa rapido: problema -> arquivo

### 0. "Qual o arquivo principal para fazer o agente responder igual eu defini no prompt e nas regras?"

Arquivo principal:
- [supabase/functions/ai-processor/subagent.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\subagent.ts)

Este e o arquivo mais importante para obediencia real do agente.

Ele:
- monta o prompt final de verdade
- junta `PERSONALITY` + prompt da etapa + regras + conhecimento + contexto do lead
- define a prioridade das instrucoes
- injeta a memoria comercial e o comportamento da etapa

Se voce quer que o agente responda mais fiel ao que foi definido, este e o primeiro arquivo que precisa revisar.

Arquivos que trabalham junto com ele:
- [src/components/subagentes/PromptEditor.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\components\subagentes\PromptEditor.tsx)
- [src/app/regras/page.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\app\regras\page.tsx)
- [src/lib/message-policy.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\lib\message-policy.ts)
- [supabase/functions/_shared/message-governance.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\_shared\message-governance.ts)
- [supabase/functions/whatsapp-sender/index.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\whatsapp-sender\index.ts)

Ordem pratica de revisao:
1. `PromptEditor.tsx`
- confirma se o prompt da etapa ou `PERSONALITY` foi salvo mesmo
- se existir `prompt_override` no banco, o runtime usa ele no lugar do padrao do codigo

2. `regras/page.tsx`
- confirma se a regra foi salva na tela certa

3. `message-policy.ts`
- confirma se a regra esta sendo normalizada do jeito esperado

4. `message-governance.ts`
- confirma se a regra virou instrucao real para o modelo

5. `subagent.ts`
- ponto principal de obediencia do agente

6. `whatsapp-sender/index.ts`
- ultima camada
- se a resposta estava certa no runtime, mas chegou diferente no WhatsApp, revise aqui

### 1. "O agente esta respondendo diferente das instrucoes das Regras"

Verifique primeiro:
- [src/app/regras/page.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\app\regras\page.tsx)
- [src/lib/message-policy.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\lib\message-policy.ts)
- [supabase/functions/_shared/message-governance.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\_shared\message-governance.ts)
- [supabase/functions/ai-processor/subagent.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\subagent.ts)
- [supabase/functions/whatsapp-sender/index.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\whatsapp-sender\index.ts)

Funcao de cada um:
- `regras/page.tsx`: tela onde voce salva as regras gerais, saudacao, formato e proibicoes
- `message-policy.ts`: padrao e normalizacao dessas regras
- `message-governance.ts`: transforma essas regras em instrucao real para o runtime
- `subagent.ts`: injeta essas regras dentro do prompt do agente
- `whatsapp-sender/index.ts`: ultima camada antes do envio; pode dividir, sanitizar ou alterar formato final

Se a regra nao esta sendo obedecida:
- primeiro veja se a regra foi salva na tela `Regras`
- depois veja se o runtime esta lendo `message_policy`
- por fim veja se o sender esta quebrando ou repartindo a resposta

### 2. "Quero melhorar a inteligencia do agente E4"

Arquivos principais:
- [src/components/subagentes/PromptEditor.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\components\subagentes\PromptEditor.tsx)
- [supabase/functions/ai-processor/subagent.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\subagent.ts)
- [supabase/functions/ai-processor/tools.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\tools.ts)
- [supabase/functions/ai-processor/tool-schemas.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\tool-schemas.ts)
- [supabase/functions/ai-processor/intelligence.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\intelligence.ts)

Onde mexer dependendo do objetivo:
- se for tom, condução, argumentacao, estrutura comercial da E4: mexa no prompt da E4 via dashboard ou no runtime editorial em `subagent.ts`
- se for comportamento de tool, por exemplo atualizar lead, avancar etapa, tratar financeiro: mexa em `tools.ts`
- se for liberar ou restringir ferramenta da E4: mexa em `tool-schemas.ts` e em `subagent.ts`
- se for melhorar leitura de intencao, desconto, proposta, urgencia, momento de compra: mexa em `intelligence.ts`

Regra pratica:
- "fala melhor" = prompt
- "decide melhor" = `intelligence.ts`
- "executa melhor" = `tools.ts`
- "pode ou nao pode usar recurso" = `tool-schemas.ts` + `subagent.ts`

### 3. "Quero deixar o agente mais inteligente no geral"

Arquivos mais importantes:
- [supabase/functions/ai-processor/subagent.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\subagent.ts)
- [supabase/functions/ai-processor/intelligence.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\intelligence.ts)
- [supabase/functions/ai-processor/knowledge.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\knowledge.ts)
- [supabase/functions/ai-processor/catalog-resolver.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\catalog-resolver.ts)
- [supabase/functions/ai-processor/judge.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\judge.ts)
- [supabase/functions/_shared/openai-client.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\_shared\openai-client.ts)

Funcao de cada um:
- `subagent.ts`: cerebro editorial principal; monta prompt, contexto, regras, memoria comercial e chamada do modelo
- `intelligence.ts`: classifica intenção, estagio de compra, objecao, urgencia, proposta, matricula, handoff
- `knowledge.ts`: busca e formata conhecimento para o agente usar
- `catalog-resolver.ts`: ajuda a decidir quando a mensagem esta falando de curso, area, filtro ou follow-up do curso atual
- `judge.ts`: camada de avaliacao/controle adicional antes da resposta final
- `openai-client.ts`: cliente de modelo; se quiser trocar comportamento de chamada, modelo, temperatura ou formato, olhar aqui

Se a meta for:
- entender melhor o lead = `intelligence.ts`
- responder com mais contexto = `knowledge.ts`
- entender melhor pergunta de curso = `catalog-resolver.ts` + `tools.ts`
- melhorar a composicao do prompt = `subagent.ts`

### 4. "O agente nao esta consultando conhecimento quando deveria"

Arquivos principais:
- [src/app/conhecimento/page.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\app\conhecimento\page.tsx)
- [supabase/functions/ai-processor/knowledge.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\knowledge.ts)
- [supabase/functions/ai-processor/tools.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\tools.ts)
- [supabase/functions/_shared/openai-vector-store.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\_shared\openai-vector-store.ts)

Funcao:
- `conhecimento/page.tsx`: tela de cadastro e edicao da base de conhecimento
- `knowledge.ts`: transforma itens salvos em contexto util para o prompt
- `tools.ts`: implementa a tool `consultar_conhecimento`
- `openai-vector-store.ts`: busca no catalogo/Vector Store

Se o problema for:
- item nao existe ou esta ruim = mexa em `conhecimento/page.tsx` ou no dado salvo
- busca nao esta encontrando = mexa em `tools.ts` e `openai-vector-store.ts`
- item existe mas nao entra no prompt = mexa em `knowledge.ts`

### 5. "O agente fala curso errado, nao confirma curso ou nao lista opcoes direito"

Arquivos principais:
- [supabase/functions/ai-processor/tools.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\tools.ts)
- [supabase/functions/ai-processor/catalog-resolver.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\catalog-resolver.ts)
- [supabase/functions/ai-processor/subagent.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\subagent.ts)

Funcao:
- `tools.ts`: regra real de consulta de curso, ambiguidades, filtro por area, browse, match e salvamento
- `catalog-resolver.ts`: ajuda a detectar intencao de catalogo no historico
- `subagent.ts`: injeta regra obrigatoria de consulta antes de responder

Se quiser:
- melhorar match de nome de curso = `tools.ts`
- melhorar deteccao de quando a pessoa ainda fala do mesmo curso = `catalog-resolver.ts` + `subagent.ts`
- mudar regra de pausa obrigatoria quando curso nao bate = `tools.ts`

### 6. "O agente nao avanca de etapa ou avanca na hora errada"

Arquivos principais:
- [supabase/functions/ai-processor/index.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\index.ts)
- [supabase/functions/ai-processor/tools.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\tools.ts)
- [supabase/functions/ai-processor/router.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\router.ts)
- [supabase/functions/ai-processor/subagent.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\subagent.ts)

Funcao:
- `index.ts`: orquestra trocas de etapa, stage handoff e cadeia E1 -> E7
- `tools.ts`: implementa `avancar_etapa`
- `router.ts`: mapeia `etapa_atual` para subagente
- `subagent.ts`: define objetivo da etapa e orienta o agente sobre quando assumir

Se o problema for:
- E1 nao vai para E2 = `index.ts` e logica de force advance estrutural
- etapa avancou mas proximo agente nao assumiu = `index.ts` + `router.ts`
- agente avanca cedo demais = prompt da etapa + `subagent.ts` + `tools.ts`

### 7. "Se eu mexer em um arquivo, quais outros devo revisar junto?"

Arquivos interligados mais importantes:

- `subagent.ts` + `tool-schemas.ts` + `tools.ts`
  Motivo: um define o que pode usar, outro define contrato da tool, outro implementa a tool

- `webhook-receiver/index.ts` + `debounce-worker/index.ts` + `ai-processor/index.ts` + `whatsapp-sender/index.ts`
  Motivo: isso e o pipeline inteiro de entrada e saida

### 7.1. "Quando o lead manda 2 ou mais mensagens seguidas e o agente responde errado"

Arquivos principais:
- [supabase/functions/webhook-receiver/index.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\webhook-receiver\index.ts)
- [supabase/functions/debounce-worker/index.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\debounce-worker\index.ts)
- [supabase/functions/ai-processor/subagent.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\subagent.ts)

Funcao de cada um:
- `webhook-receiver/index.ts`: recebe cada mensagem individual, identifica o lead certo e coloca na fila sem resetar a etapa do lead
- `debounce-worker/index.ts`: junta mensagens em rajada na mesma janela e monta o contexto consolidado antes de chamar a IA
- `subagent.ts`: consome o historico consolidado e decide como responder quando vieram 2 ou mais mensagens proximas

Se o erro for:
- o lead mandou 2 mensagens e o sistema tratou como conversa nova = veja primeiro `webhook-receiver/index.ts`
- o lead mandou 2 mensagens e o agente respondeu so a primeira ou perdeu contexto da segunda = veja `debounce-worker/index.ts`
- o historico chegou certo mas a IA interpretou errado a rajada = veja `subagent.ts`

- `regras/page.tsx` + `message-policy.ts` + `message-governance.ts`
  Motivo: tela salva a regra, normalizador estrutura a regra, runtime aplica a regra

- `conhecimento/page.tsx` + `knowledge.ts` + `tools.ts`
  Motivo: tela cadastra o item, runtime carrega, tool consulta

- `agent-definitions.ts` + `PromptEditor.tsx` + `subagent.ts`
  Motivo: editor salva prompt customizado, helper le override, runtime usa esse texto real

- `intelligence.ts` + `LeadIntelligencePanel.tsx`
  Motivo: classificacao do backend afeta leitura e exibicao comercial no frontend

### 8. "O agente esta com tom errado, muito robotico ou muito solto"

Arquivos:
- [src/components/subagentes/PromptEditor.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\components\subagentes\PromptEditor.tsx)
- [supabase/functions/ai-processor/subagent.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\subagent.ts)
- [src/app/regras/page.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\app\regras\page.tsx)

O que cada um controla:
- `PromptEditor.tsx`: permite editar PERSONALITY e cada etapa
- `subagent.ts`: combina PERSONALITY + etapa + regras + conhecimento
- `regras/page.tsx`: pode forcar proibicoes e estilo operacional

Se o tom estiver errado em todas as etapas:
- mexa em `PERSONALITY`

Se o tom estiver errado so numa etapa:
- mexa no prompt daquela etapa

Se o tom estiver certo no prompt mas errado na saida:
- veja `regras/page.tsx` e `message-governance.ts`

### 9. "O agente nao esta salvando nome, cidade, curso, pagamento ou matricula"

Arquivos:
- [supabase/functions/ai-processor/tools.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\tools.ts)
- [supabase/functions/ai-processor/tool-schemas.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\tool-schemas.ts)
- [supabase/migrations](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\migrations)

Funcao:
- `tools.ts`: atualiza lead, registra matricula, indicacao, handoff, notificacao
- `tool-schemas.ts`: define o que o modelo pode enviar para essas tools
- `migrations`: definem colunas reais do banco

Se nao salva:
- veja se a tool existe em `tools.ts`
- veja se a schema permite chamar essa tool
- veja se a coluna existe no banco

### 10. "A mensagem entra, mas o agente nao responde"

Arquivos principais:
- [supabase/functions/webhook-receiver/index.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\webhook-receiver\index.ts)
- [supabase/functions/debounce-worker/index.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\debounce-worker\index.ts)
- [supabase/functions/ai-processor/index.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\index.ts)
- [supabase/functions/whatsapp-sender/index.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\whatsapp-sender\index.ts)
- [supabase/functions/_shared/pgmq.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\_shared\pgmq.ts)
- [supabase/migrations/20260003_vendas_filas_cron.sql](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\migrations\20260003_vendas_filas_cron.sql)
- [supabase/migrations/20260017_queue_name_alignment.sql](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\migrations\20260017_queue_name_alignment.sql)

Ordem de checagem:
1. `webhook-receiver`: recebeu e salvou?
2. fila: entrou em `messages_vendas`?
3. `debounce-worker`: consolidou?
4. fila: entrou em `ai_processing_vendas`?
5. `ai-processor`: gerou texto?
6. `whatsapp-sender`: enviou?

Se entrar no webhook e parar na fila:
- problema em `pgmq.ts`, nomes de fila, migration ou debounce

Se chegar no ai-processor e nao sair:
- problema em `subagent.ts`, `intelligence.ts`, `tools.ts` ou credenciais OpenAI

Se gerar texto mas nao mandar:
- problema em `whatsapp-sender/index.ts` ou Evolution API

### 11. "Quero mudar mapeamento ou objetivo das etapas E1 a E7"

Arquivos:
- [src/lib/types.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\lib\types.ts)
- [supabase/functions/ai-processor/router.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\router.ts)
- [supabase/functions/ai-processor/subagent.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\subagent.ts)
- [supabase/functions/ai-processor/tools.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\tools.ts)

Funcao:
- `types.ts`: nomes, labels, objetivos mostrados no frontend
- `router.ts`: qual subagente atende cada etapa
- `subagent.ts`: objetivo de cada etapa no runtime
- `tools.ts`: ordem natural de avanço entre etapas

Se alterar uma etapa:
- quase sempre revise os 4

### 12. "Quero mudar prompts padrao do codigo, nao so o override da dashboard"

Arquivos:
- [supabase/functions/ai-processor/subagent.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\subagent.ts)
- [supabase/seed.sql](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\seed.sql)
- [src/components/subagentes/PromptEditor.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\components\subagentes\PromptEditor.tsx)

Funcao:
- `subagent.ts`: fallback real em runtime
- `seed.sql`: pode definir base inicial para dashboard/banco
- `PromptEditor.tsx`: mostra e salva override

Se voce mudar padrao no codigo, lembre:
- se existir `prompt_override` salvo no banco, o runtime usa override e ignora o padrao

### 13. "Quero mexer na tela, dashboard ou UX do projeto"

Arquivos comuns:
- [src/app/page.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\app\page.tsx)
- [src/app/DashboardClient.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\app\DashboardClient.tsx)
- [src/components](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\components)
- [src/hooks/useRealtime.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\hooks\useRealtime.ts)
- [src/lib/supabase.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\lib\supabase.ts)

Funcao:
- `page.tsx` e `DashboardClient.tsx`: estrutura principal do dashboard
- `components`: blocos visuais
- `useRealtime.ts`: atualizacao em tempo real
- `supabase.ts`: camada de consulta e update do frontend

### 14. "Quero mudar configuracoes da Evolution ou do WhatsApp"

Arquivos:
- [src/app/api/evolution/route.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\app\api\evolution\route.ts)
- [src/app/api/settings/route.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\app\api\settings\route.ts)
- [supabase/functions/_shared/evolution-api.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\_shared\evolution-api.ts)
- [supabase/functions/whatsapp-sender/index.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\whatsapp-sender\index.ts)
- [supabase/functions/webhook-receiver/index.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\webhook-receiver\index.ts)

Funcao:
- `route.ts` de evolution: teste de conexao e envio pelo frontend
- `settings/route.ts`: salva configuracoes da tenant e instancia
- `_shared/evolution-api.ts`: funcoes compartilhadas de integracao
- `whatsapp-sender`: envio
- `webhook-receiver`: entrada

## Arquivos mais importantes do projeto

### [supabase/functions/ai-processor/subagent.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\subagent.ts)
Arquivo mais importante do comportamento do agente.

Faz:
- monta prompt final
- combina PERSONALITY + etapa + regras + conhecimento + inteligencia
- define quais tools cada etapa pode usar
- aplica comportamento de `stage_handoff`
- controla parte grande da inteligencia conversacional

### [supabase/functions/ai-processor/index.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\index.ts)
Orquestrador do pipeline de IA.

Faz:
- le fila `ai_processing_vendas`
- chama subagente
- trata troca automatica de etapa
- chama sender
- grava eventos e follow-up

### [supabase/functions/ai-processor/tools.ts](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\supabase\functions\ai-processor\tools.ts)
Arquivo mais importante das acoes reais.

Faz:
- ler lead
- atualizar lead
- avancar etapa
- handoff
- registrar matricula
- registrar indicacao
- consultar conhecimento e curso

### [src/app/regras/page.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\app\regras\page.tsx)
Tela operacional mais importante para ajustar comportamento sem mexer no codigo.

Faz:
- salvar regras gerais
- controlar saudacao
- controlar estrutura da mensagem
- definir caracteres proibidos

### [src/components/subagentes/PromptEditor.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\components\subagentes\PromptEditor.tsx)
Tela mais importante para editar o "cerebro editorial" sem deploy.

Faz:
- editar PERSONALITY
- editar prompt de E1 a E7
- salvar override no banco

### [src/app/conhecimento/page.tsx](C:\Users\fapps\Documents\Projetos\Agent Hub - Fapps\src\app\conhecimento\page.tsx)
Tela central da base de conhecimento.

Faz:
- cadastrar links
- cadastrar FAQ
- cadastrar conteudo institucional
- editar itens usados pelo runtime

## Quando um arquivo exige revisar outro

- Alterou nome de fila:
  revise `webhook-receiver/index.ts`, `debounce-worker/index.ts`, `ai-processor/index.ts`, `_shared/pgmq.ts` e migrations

- Alterou etapa E4:
  revise prompt da E4, `subagent.ts`, `tools.ts`, `tool-schemas.ts`, `intelligence.ts`

- Alterou regra operacional:
  revise `regras/page.tsx`, `message-policy.ts`, `message-governance.ts`, `subagent.ts`

- Alterou conhecimento de curso:
  revise `tools.ts`, `catalog-resolver.ts`, `knowledge.ts`

- Alterou banco:
  revise migrations, tipos em `src/lib/types.ts` e usos no frontend/backend

## Checklist antes de pedir uma mudanca

Quando voce quiser pedir algo depois, use este formato:

1. Problema observado
- exemplo: "E4 esta falando de desconto cedo demais"

2. Camada suspeita
- prompt
- regra
- inteligencia
- tool
- fila
- sender
- banco

3. Arquivo alvo
- exemplo: `supabase/functions/ai-processor/intelligence.ts`

4. Arquivos relacionados
- exemplo: `subagent.ts` e `tools.ts`

5. Resultado esperado
- exemplo: "so falar de desconto quando a conversa ja estiver em E4 e o lead pedir condicao"

## Exemplo de pedidos bons

- "Quero melhorar a inteligencia de proposta da E4. Revise `supabase/functions/ai-processor/intelligence.ts` e `supabase/functions/ai-processor/subagent.ts`."
- "Quero que as Regras tenham mais prioridade no texto final. Revise `src/app/regras/page.tsx`, `src/lib/message-policy.ts` e `supabase/functions/_shared/message-governance.ts`."
- "Quero mudar a confirmacao de curso para nao seguir sem match oficial. Revise `supabase/functions/ai-processor/tools.ts` e `catalog-resolver.ts`."
- "Quero que o fluxo avance melhor de E1 para E2. Revise `supabase/functions/ai-processor/index.ts` e `tools.ts`."
- "Quero melhorar a resposta final enviada no WhatsApp. Revise `subagent.ts` e `whatsapp-sender/index.ts`."

## Resumo final

Se voce tiver duvida de onde mexer, pense assim:

- problema de fala = prompt ou regras
- problema de decisao = `intelligence.ts`
- problema de acao = `tools.ts`
- problema de etapa = `index.ts` + `router.ts` + `subagent.ts`
- problema de conhecimento = `conhecimento/page.tsx` + `knowledge.ts` + `tools.ts`
- problema de entrada/saida = `webhook-receiver` + `debounce-worker` + `ai-processor` + `whatsapp-sender`
- problema de tela = `src/app` + `src/components`
