# FLUXO ATUAL DO AGENTHUB

Este arquivo descreve 3 coisas, sem misturar:
- o que a estrutura realmente exige
- como a orquestracao dos agentes funciona
- como prompt e estrutura se relacionam

Nao descreve intencao ideal.

Descreve comportamento estrutural real do codigo hoje.

## 1. Visao geral

Fluxo bruto:
- WhatsApp envia mensagem
- `webhook-receiver` recebe
- mensagem entra em `mensagens`
- `debounce-worker` junta mensagens proximas
- `ai-processor` le etapa atual
- `router/subagent` escolhe subagente
- estrutura decide se precisa consulta, trava, handoff ou avance
- texto final vai para `whatsapp-sender`
- governanca formata e divide bolhas
- resposta volta para WhatsApp

Arquivos centrais:
- `supabase/functions/webhook-receiver/index.ts`
- `supabase/functions/debounce-worker/index.ts`
- `supabase/functions/ai-processor/index.ts`
- `supabase/functions/ai-processor/subagent.ts`
- `supabase/functions/ai-processor/tools.ts`
- `supabase/functions/_shared/admin-checkpoints.ts`
- `supabase/functions/ai-processor/catalog-resolver.ts`
- `supabase/functions/_shared/message-governance.ts`
- `supabase/functions/whatsapp-sender/index.ts`

## 2. O que a estrutura realmente exige

Esta secao fala so de exigencia estrutural dura.

Nao fala de estilo.

Nao fala de personalidade.

Nao fala de qualidade editorial.

### 2.1. E1

Para permitir `E1 -> E2`, a estrutura exige:
- `nome`
- `cidade`
- `curso_interesse`
- `modalidade`
- `dor_principal`

Se faltar qualquer um:
- `tool_avancar_etapa` bloqueia
- a etapa nao avanca

Se o curso vier com mais de uma linha real:
- E1 nao pode avancar
- E1 precisa esperar escolha da linha

Se o curso nao existir:
- E1 nao pode seguir fluxo comercial
- E1 precisa redirecionar para outra opcao

Se resposta do lead resolver cidade por contexto:
- estrutura tenta salvar cidade silenciosamente

Se resposta do lead resolver motivacao por contexto:
- estrutura marca isso como resposta contextual
- evita tratar como nova consulta de curso

Existe force advance estrutural em E1:
- so acontece se o backend entender que E1 terminou mesmo sem `avancar_etapa` perfeito
- hoje isso depende de snapshot do lead e validacao textual
- mesmo assim, o `tool_avancar_etapa` ainda revalida os campos obrigatorios

### 2.2. E2

Estrutura valida com dureza principalmente o fechamento do combinado comercial.

Para aceitar `E2 -> E3`, a estrutura exige:
- o historico mostrar que a pergunta de combinado foi feita
- a ultima resposta do lead indicar aceite

Aceites que a estrutura reconhece hoje:
- `sim`
- `combinado`
- `seguimos sim`
- `fechado`
- `pode ser`
- `se a bolsa ficar boa`
- `dependendo do valor`
- `se couber no meu bolso`

Se E2 tentar avancar sem isso:
- estrutura remove `avancar_etapa`
- estrutura troca a resposta por fallback do combinado

Observacao:
- disponibilidade e decisor existem forte no prompt
- mas a trava estrutural mais clara hoje esta no combinado

### 2.3. E3

Estrutura protege principalmente o salto automatico de `E3 -> E4`.

E3 nao pode falar preco nem desconto.

Se a resposta da E3 tentar fazer isso:
- estrutura corta esse trecho
- e sobe para `E4` quando o lead ja demonstrou interesse suficiente ou quer saber valores

No `stage_handoff`, E3 so pode avancar se a ultima mensagem do lead for financeira ou indicar interesse comercial claro.

Perguntas financeiras reconhecidas hoje:
- `qual o valor`
- `qual valor`
- `quanto custa`
- `quanto fica`
- `mensalidade`
- `preco`
- `parcela`
- `bolsa`
- `desconto`

Se E3 tentar avancar no handoff sem isso:
- estrutura bloqueia o avance
- remove `avancar_etapa`
- limpa trechos indevidos da resposta

Observacao:
- E3 ainda depende do prompt para construir valor
- mas preco e desconto agora estao travados estruturalmente

### 2.4. E4

Agora E4 tem 2 checkpoints administrativos estruturais.

Checkpoint 1:
- pedir nome completo
- explicar que nao gera compromisso
- explicar que e apenas um documento com informacoes e condicoes da bolsa
- avisar admin
- pausar lead

Checkpoint 2:
- quando lead quiser concluir matricula
- avisar admin
- pausar lead de novo

Depois da retomada:
- seguir negociacao
- tratar objecao real de preco
- sem inventar desconto
- sem dizer valor na resposta estrutural

Travamento estrutural:
- `tool_avancar_etapa` nao passa se existir checkpoint admin pendente
- `ai-processor` tambem recusa processar payload se ainda existir checkpoint pendente
- `webhook-receiver` salva mensagem do lead durante pausa, mas nao enfileira atendimento

Retomada:
- admin precisa responder diretamente a mensagem administrativa
- correlacao principal e feita por `admin_message_id`
- nao usa heuristica por nome
- nao usa "ultimo lead pendente"
- reply sem correlacao segura vira log e nao destrava nada

Arquivos:
- `supabase/functions/_shared/admin-checkpoints.ts`
- `supabase/functions/webhook-receiver/index.ts`
- `supabase/functions/ai-processor/index.ts`
- `supabase/functions/ai-processor/tools.ts`

### 2.5. E5

E5 deixou de ser confirmacao de pagamento.

Agora a estrutura exige:
- parabenizar pela matricula concluida
- perguntar se o boleto vai ser para `hoje` ou `proxima segunda-feira`
- aceitar outra data

Se outra data aparecer:
- estrutura notifica admin
- responde naturalmente para o lead
- nao discute a data

Se E5 tentar voltar para:
- modalidade
- ensino medio
- forma de pagamento
- valor pago

a estrutura sobrescreve com pergunta correta do boleto.

Depois da data do boleto:
- estrutura forca `E5 -> E6`

### 2.6. E6

E6 agora comeca com validacao do atendimento:
- perguntar se o lead gostou do atendimento
- perguntar se recomendaria para outra pessoa

Se a resposta for positiva:
- agradecer de forma humana
- pedir o nome do indicado

Depois disso:
- nome do indicado
- telefone do indicado
ou
- sem indicacao

Se ultima mensagem parecer nome:
- salva nome pendente
- pede telefone

Se ultima mensagem parecer telefone:
- registra indicacao
- limpa nome pendente
- avanca `E6 -> E7`

Se lead disser que nao tem indicacao:
- estrutura aceita
- marca `no_indication`
- avanca `E6 -> E7`

Se a resposta sobre recomendacao for negativa:
- estrutura nao insiste
- trata como sem indicacao
- avanca `E6 -> E7`

Se agente tentar perguntar curso ou area do indicado:
- estrutura bloqueia
- volta para pedido de telefone

### 2.7. E7

E7 faz fechamento humano.

Se houve indicado:
- orienta que alguem da instituicao pode entrar em contato
- nao abre mini-qualificacao

Se nao houve indicado:
- faz encerramento humano direto

Se resposta tentar reabrir venda do indicado:
- estrutura corrige para fechamento

## 3. O que a estrutura detecta por contexto

Antes de decidir se uma mensagem e nova consulta ou resposta contextual, a estrutura tenta classificar a fala do lead.

Hoje detecta principalmente:
- resposta de cidade
- resposta de motivacao
- nome completo para proposta
- nome de pessoa
- telefone
- pergunta financeira
- escolha de data do boleto
- ausencia de indicacao

Isso acontece em:
- `catalog-resolver.ts`
- `index.ts`
- `subagent.ts`

Objetivo:
- impedir que uma resposta curta seja tratada como assunto novo
- impedir que uma pergunta financeira seja jogada para etapa errada
- impedir que nome de indicado vire consulta de curso

## 4. Como a orquestracao dos agentes funciona

### 4.1. Entrada

1. `webhook-receiver` recebe evento
2. ignora mensagem do proprio agente
3. salva inbound em `mensagens`
4. registra evento de teste/log
5. envia para fila principal

### 4.2. Consolidacao

1. `debounce-worker` espera janela curta
2. junta mensagens proximas do mesmo lead
3. monta `texto_consolidado`
4. chama `ai-processor`

Isto evita:
- responder so a primeira de varias mensagens seguidas
- perder contexto imediato

### 4.3. Inicio do processamento IA

`ai-processor`:
- le lead
- le etapa atual
- le historico
- le configuracao do tenant
- le regras de mensagem
- le prompt da etapa
- le contexto comercial salvo

Depois disso:
- escolhe subagente da etapa atual
- roda um loop de ate `AUTO_STAGE_HANDOFF_LIMIT = 3`

Objetivo do loop:
- permitir que uma etapa conclua
- avance
- proxima etapa assuma no mesmo processamento

### 4.4. Escolha do subagente

Mapa atual:
- `E1`
- `E2`
- `E3`
- `E4`
- `E5`
- `E6`
- `E7`

Cada etapa chama:
- mesmo runtime
- mesmo orquestrador
- prompt diferente
- conjunto de regras estruturais igual, mas aplicado conforme etapa

### 4.5. O que o subagente recebe

O subagente recebe:
- prompt base da etapa
- override salvo no banco, se existir
- historico consolidado
- dados atuais do lead
- ferramentas permitidas para aquela etapa
- instrucoes adicionais da estrutura

Ferramentas comuns:
- `ler_lead`
- `atualizar_lead`
- `avancar_etapa`
- `acionar_handoff`
- `consultar_conhecimento`

Ferramentas por etapa:
- `registrar_matricula` em E5
- `registrar_indicacao` em E6

### 4.6. Consulta obrigatoria antes da resposta

Antes de deixar o modelo responder livremente, a estrutura pode intervir.

Caso principal:
- lead citou curso especifico

Entao:
- `subagent.ts` detecta intencao de catalogo
- `forceCourseLookup` executa `consultar_conhecimento`
- `buildDeterministicCatalogReply` pode montar resposta pronta

Isto acontece antes do texto livre do modelo.

Objetivo:
- impedir curso inventado
- impedir disponibilidade falsa
- impedir seguir venda com curso nao confirmado

### 4.7. Execucao da etapa

Durante a etapa:
- modelo pode responder com texto
- modelo pode chamar tool
- tools escrevem no banco
- runtime registra `tool_calls`

Se etapa chamar `avancar_etapa` com sucesso:
- `stageOutput.avancou = true`
- orquestrador le etapa nova
- roda proxima etapa no mesmo ciclo

Se etapa chamar `acionar_handoff` com sucesso:
- `stageOutput.handoff = true`
- automacao para

### 4.8. Saneamentos estruturais

Depois que a etapa gera saida, `ai-processor/index.ts` ainda pode corrigir.

Exemplos:
- bloquear avance invalido em E2
- bloquear avance invalido em E3
- corrigir desvio financeiro em E4
- concluir E5 por confirmacao de pagamento
- capturar nome/telefone de indicado em E6
- fechar E7 quando ela tenta reabrir conversa

Ou seja:
- subagente fala primeiro
- estrutura revisa depois

### 4.9. Encadeamento entre etapas

Se etapa atual avancou:
- sistema consulta `leads.etapa_atual`
- se mudou para etapa normal, proxima assume
- trigger vira `stage_handoff`

No `stage_handoff`:
- nova etapa entra sem esperar novo inbound
- prompt recebe instrucoes para nao repetir etapa anterior

Se nao avancou:
- loop para
- resposta final fica na etapa atual

### 4.10. Saida para WhatsApp

Quando texto final fica pronto:
- `whatsapp-sender` recebe
- aplica `applyMessageGovernance`
- divide bolhas com `splitTextForMessagePolicy`
- envia uma a uma
- salva outbound em `mensagens`
- registra log em `lead_events`

## 5. Relacao entre prompt e estrutura

Este e ponto mais importante.

Prompt e estrutura nao fazem mesma funcao.

### 5.1. O que o prompt faz

Prompt decide:
- personalidade
- entusiasmo
- acolhimento
- curiosidade
- tom
- forma de reagir
- forma de perguntar
- ordem conversacional quando houver mais de um caminho natural
- nivel de detalhe
- wording

Prompt tambem diz:
- o que a etapa deveria fazer
- o que nao deveria dizer
- como deveria soar

### 5.2. O que a estrutura faz

Estrutura decide:
- quando consultar curso obrigatoriamente
- quando bloquear avance
- quando permitir avance
- quando subir etapa no mesmo ciclo
- quando travar handoff
- quando sobrescrever resposta perigosa
- quando interpretar mensagem curta como cidade, motivacao, nome, telefone ou financeiro
- como formatar e dividir mensagem no WhatsApp

### 5.3. Onde prompt fala primeiro

Prompt fala primeiro quando:
- modelo recebe historico e instrucoes da etapa
- modelo escolhe redacao
- modelo escolhe tom
- modelo decide se usa tool

Isto acontece dentro de:
- `subagent.ts`

### 5.4. Onde estrutura fala antes do prompt

Estrutura fala antes do prompt quando:
- detecta que mensagem e audio placeholder
- detecta que resposta e contextual e nao nova consulta
- detecta que consulta de curso e obrigatoria
- executa consulta antes da fala livre
- monta resposta deterministica de catalogo

Nestes casos:
- prompt nao some
- mas perde liberdade

### 5.5. Onde estrutura fala depois do prompt

Estrutura fala depois do prompt quando:
- remove `avancar_etapa` invalido
- remove `acionar_handoff` invalido
- troca resposta por fallback mais segura
- promove etapa automaticamente
- corrige saida financeira
- corrige fluxo de indicacao
- corrige fechamento final

Nestes pontos:
- prompt ja falou
- estrutura revisa
- se achar risco de fluxo, estrutura vence

### 5.6. Quando prompt vence

Prompt vence principalmente em:
- personalidade
- entusiasmo
- calor humano
- forma de construir ponte
- escolha fina das palavras
- reacao ao que o lead acabou de dizer

Se estrutura nao entrar com resposta deterministica ou fallback:
- quem manda no texto e o prompt

### 5.7. Quando estrutura vence

Estrutura vence quando ha risco de:
- curso inventado
- area inventada
- etapa pular criterio obrigatorio
- pergunta financeira ir para lugar errado
- pagamento confirmado sem regra
- indicacao quebrar sequencia
- E7 reabrir venda
- formato de WhatsApp sair quebrado

### 5.8. Onde costumam nascer conflitos

Conflitos comuns:
- prompt quer soar humano, estrutura devolve fallback seco
- prompt quer continuar conversa, estrutura detecta bloqueio de etapa
- prompt quer interpretar livremente, estrutura exige consulta
- prompt quer avancar, estrutura ainda nao aceita
- prompt gera lista bonita, governanca quebra bolha

Arquivos onde isso costuma acontecer:
- `subagent.ts`
- `index.ts`
- `tools.ts`
- `catalog-resolver.ts`
- `message-governance.ts`

## 6. Ordem real da interacao prompt x estrutura

Fluxo real:

1. mensagem chega
2. estrutura salva e consolida
3. estrutura escolhe etapa
4. prompt da etapa e carregado
5. estrutura injeta contexto extra e guardas
6. se precisar, estrutura consulta curso antes
7. modelo responde ou chama tools
8. estrutura revisa resultado
9. se preciso, estrutura bloqueia ou corrige
10. se etapa avancou, nova etapa assume no mesmo ciclo
11. texto final vai para governanca
12. governanca divide e envia no WhatsApp

## 7. O que este documento quer deixar claro

Se problema for:
- etapa pulando errada
- etapa misturando com outra
- consulta obrigatoria nao acontecendo
- handoff errado
- indicacao quebrada
- resposta financeira indo para lugar errado

olhe primeiro:
- `ai-processor/index.ts`
- `ai-processor/tools.ts`
- `ai-processor/subagent.ts`
- `ai-processor/catalog-resolver.ts`

Se problema for:
- resposta seca
- pouca personalidade
- falta de entusiasmo
- frase fria
- ponte humana fraca
- wording ruim

olhe primeiro:
- `agent_definitions.config.prompt_override`
- fallback deterministico em `subagent.ts`
- fallback estrutural em `index.ts`

Se problema for:
- bolha quebrada
- lista desmontada
- mensagem separada errado
- caractere removido

olhe primeiro:
- `message-governance.ts`
- `whatsapp-sender/index.ts`

## 8. Resumo final

Resumo curto:
- prompt define como falar
- estrutura define quando pode falar, o que nao pode errar e quando pode passar etapa
- orquestrador costura uma etapa na outra
- consulta, guardas, fallbacks e governanca sao os pontos em que a estrutura mais interfere

Traduzindo:
- prompt vende
- estrutura segura trilho
- orquestrador passa bastao
