# Saneamento AgentHub Para Producao

Base:
- especificacao colada em `pasted-text.txt`
- leitura real do codigo atual

Objetivo deste arquivo:
- mapear o que hoje gera comportamento comercial
- classificar cada bloco
- apontar o que deve ficar, reescrever ou remover

Legenda:
- `A` faz parte do processo
- `B` suporte tecnico necessario
- `C` comportamento comercial nao autorizado

## 1. Arquivos mapeados

- `supabase/functions/ai-processor/index.ts`
- `supabase/functions/ai-processor/subagent.ts`
- `supabase/functions/ai-processor/tools.ts`
- `supabase/functions/ai-processor/catalog-resolver.ts`
- `supabase/functions/_shared/message-governance.ts`
- `supabase/functions/whatsapp-sender/index.ts`

## 2. Achados principais

### 2.1. Contrato estrutural da E1

Status atual:
- `tool_avancar_etapa` exige `nome`
- `cidade`
- `curso_interesse`
- `modalidade`
- `dor_principal`

Classificacao:
- `A` exigir nome, cidade e curso
- `C` exigir modalidade como pergunta comercial livre
- `C` exigir dor_principal como se o processo dependesse de dor

Acao:
- trocar contrato para curso validado, linha quando necessaria, cidade, motivacao/relacao com a area, modalidade derivada da oferta

Arquivos:
- `supabase/functions/ai-processor/tools.ts`
- `supabase/functions/ai-processor/index.ts`

### 2.2. Consultas de curso e catalogo

Status atual:
- backend faz consulta obrigatoria em varios casos
- `subagent.ts` pode montar resposta deterministica
- `tools.ts` retorna estrutura e tambem persiste `curso_interesse`

Classificacao:
- `A` consulta obrigatoria antes de confirmar curso
- `A` normalizacao e deduplicacao
- `B` persistencia automatica de curso validado
- `C` mistura entre dado semantico e texto final em camadas diferentes

Acao:
- separar retorno semantico de renderer conversacional
- centralizar personalidade global tambem nos fallbacks e determinismos

Arquivos:
- `supabase/functions/ai-processor/subagent.ts`
- `supabase/functions/ai-processor/tools.ts`
- `supabase/functions/ai-processor/catalog-resolver.ts`

### 2.3. Fallbacks comerciais criados no backend

Status atual:
- `index.ts` possui fallbacks que falam com o lead
- `subagent.ts` possui respostas deterministicas e system prompts de contenção

Exemplos atuais:
- `buildE2AgreementFallback`
- `buildE2StageHandoffFallback`
- `buildE4FinancialFallback`
- `buildE4PriceGuardFallback`
- `buildE5PaymentGuardFallback`
- `buildE6PhoneFallback`
- `buildE7ClosingFallback`

Classificacao:
- `B` fallback de seguranca estrutural
- `C` varios textos ainda carregam conducoes comerciais nao autorizadas ou wording mecanico

Acao:
- manter logica de protecao
- reescrever redacao com camada global unica
- remover qualquer fallback que faca investigacao nao prevista no processo

Arquivos:
- `supabase/functions/ai-processor/index.ts`
- `supabase/functions/ai-processor/subagent.ts`

### 2.4. E2 com trava incompleta

Status atual:
- estrutura so trava forte o aceite do combinado
- nao existe estado deterministico separado para vacinas 1, 2 e 3

Classificacao:
- `A` validar aceite do combinado
- `C` depender do prompt para parte relevante das vacinas

Acao:
- criar estado tecnico para:
  - `vacina_disponibilidade_concluida`
  - `vacina_decisor_concluida`
  - `vacina_combinado_concluida`
- permitir `E2 -> E3` so quando as tres estiverem concluídas

Arquivos:
- `supabase/functions/ai-processor/index.ts`
- `supabase/functions/ai-processor/tools.ts`

### 2.5. E3 ainda depende demais de pergunta financeira

Status atual:
- `isE3AdvanceStructurallyValid` no handoff aceita melhor o salto quando ultima fala e financeira

Classificacao:
- `A` proteger financeiro para E4
- `C` prender E3 a pergunta de preco como gatilho principal de avance

Acao:
- liberar `E3 -> E4` tambem por interesse comercial explicito
- criar estado tecnico de apresentacao suficiente

Arquivos:
- `supabase/functions/ai-processor/index.ts`

### 2.6. E4 possui perguntas e fallbacks fora do processo

Status atual:
- backend ainda detecta e corrige perguntas sobre modalidade e ensino medio
- isso mostra que o sistema ainda produz esse desvio

Classificacao:
- `B` detector para segurar desvio
- `C` existencia de trilhas que tentam perguntar ensino medio ou modalidade

Acao:
- bloquear geracao na raiz
- remover caminhos legados que ainda permitem isso

Arquivos:
- `supabase/functions/ai-processor/index.ts`
- `supabase/functions/ai-processor/subagent.ts`

### 2.7. E5 ainda confia demais em "paguei"

Status atual:
- `userConfirmedPayment` detecta texto do lead
- `index.ts` pode registrar matricula e avancar para E6 com base nessa fala

Classificacao:
- `C` registrar matricula apenas por declaracao textual

Acao:
- separar `pagamento_declarado` de `pagamento_confirmado`
- so chamar `registrar_matricula` com fonte autoritativa
- se nao houver verificacao automatica, notificar admin

Arquivos:
- `supabase/functions/ai-processor/index.ts`
- `supabase/functions/ai-processor/tools.ts`

### 2.8. E6 e E7 estao proximas do contrato correto

Status atual:
- E6 ja trabalha bem com nome e telefone
- E7 ja bloqueia mini-venda do indicado

Classificacao:
- `A` nome -> telefone -> registrar_indicacao -> E7
- `A` E7 apenas prepara e encerra
- `B` manter guardas de protecao

Acao:
- simplificar
- remover qualquer vestigio de pergunta de curso/area do indicado

Arquivos:
- `supabase/functions/ai-processor/index.ts`

### 2.9. Governanca de mensagem

Status atual:
- preserva abertura em 3 bolhas
- preserva listas estruturadas
- saneia caracteres proibidos

Classificacao:
- `A` dividir bolhas com seguranca
- `A` preservar listas e abertura
- `B` sanitizacao de caracteres

Acao:
- manter
- adicionar validador final de saida antes do sender

Arquivos:
- `supabase/functions/_shared/message-governance.ts`
- `supabase/functions/whatsapp-sender/index.ts`

### 2.10. Narracao interna e frases-problema

Status atual:
- ja existe saneamento para termos como `proxima etapa`
- ainda ha textos internos e fallbacks com linguagem que pode soar estrutural

Classificacao:
- `A` bloquear narracao interna
- `C` manter textos legados que ainda usam transicao artificial como muleta

Acao:
- criar validador global de saida
- revisar todos os textos hardcoded

Arquivos:
- `supabase/functions/ai-processor/index.ts`
- `supabase/functions/ai-processor/subagent.ts`
- `supabase/functions/ai-processor/tools.ts`
- `supabase/functions/whatsapp-sender/index.ts`

## 3. Itens classificados como C e que precisam sair

- exigencia estrutural de `modalidade` como se viesse de pergunta livre da E1
- exigencia estrutural de `dor_principal` como contrato literal da E1
- matricula automatica baseada apenas em `paguei`
- fluxo que ainda deixa surgir pergunta de ensino medio
- fluxo que ainda deixa surgir pergunta de modalidade preferida
- qualquer trilha que pergunte semestre preferido
- qualquer trilha que requalifique indicado por curso/area
- qualquer fallback que use transicao artificial como `vamos seguir`, `proximos passos`, `etapa`

## 4. Ordem tecnica recomendada

1. criar testes que capturem os desvios atuais
2. criar camada global de personalidade
3. trocar contrato estrutural da E1
4. reestruturar renderer do catalogo
5. criar estados tecnicos da E2
6. redefinir gatilhos de avance da E3
7. corrigir fonte financeira autoritativa da E4 e E5
8. criar validador global de saida
9. reforcar logs estruturais
10. remover codigo morto e legados

## 5. Proximo bloco de implementacao

Bloco 1, mais critico:
- testes automatizados do fluxo oficial
- camada global unica de personalidade
- contrato estrutural novo da E1
- bloqueio definitivo de matricula por mera declaracao textual

Motivo:
- esses quatro pontos estabilizam trilho, voz e risco operacional
