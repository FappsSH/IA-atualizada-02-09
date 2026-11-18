# AgentHub — relatório completo de objetivo, processo e estado

**Data do relatório:** 18/11/2026  
**Finalidade:** permitir que outra IA assuma o projeto sem depender do histórico desta conversa.

Este documento separa quatro coisas que não podem ser confundidas:

1. comportamento comercial desejado pelo administrador;
2. comportamento estrutural obrigatório;
3. implementação existente no código;
4. pontos que ainda precisam de validação ou decisão.

## 1. Objetivo do produto

AgentHub é um agente comercial de WhatsApp para a Universidade Cruzeiro do Sul. Ele deve conduzir o lead desde o primeiro contato até matrícula, indicações e encerramento, usando linguagem humana, entusiasmada e personalizada.

O agente deve:

- entender texto e áudio na mesma conversa;
- manter contexto entre mensagens;
- reconhecer respostas sem exigir palavras exatas;
- consultar curso, modalidade, duração e fatos autorizados antes de afirmar algo;
- seguir a etapa correta sem pular critérios;
- personalizar fala com `PERSONALITY`;
- nunca inventar curso, preço, desconto, cidade, condição ou fato institucional;
- pausar somente quando houver checkpoint administrativo real;
- retomar somente após confirmação administrativa correta;
- dividir mensagens em bolhas naturais, sem quebrar o sentido;
- preservar estado, fila, debounce, claims, governance e sender já estabilizados.

## 2. Regra arquitetural definitiva

Esta é a divisão de responsabilidades que outra IA deve preservar:

| Camada | Responsabilidade |
|---|---|
| Estado | Decide em que critério o lead está e qual é o próximo critério. |
| Fatos/conhecimento | Dizem o que é verdadeiro sobre curso e instituição. |
| PERSONALITY + prompt da etapa | Decide como Helton fala. |
| Guard/validator | Reprova avanço ou saída incompatível. Não cria outra personalidade. |
| Regeneração | Corrige uma saída mantendo personalidade e intenção. |
| Sanitizer | Remove risco técnico/caracteres proibidos. |
| Governance | Divide e organiza bolhas. Não muda conteúdo comercial. |
| Sender | Envia texto/imagem ao WhatsApp. |

Não criar uma segunda voz comercial em TypeScript. Fallback estrutural, quando inevitável, deve ser mínimo, contextual e compatível com a personalidade.

Não alterar fila, debounce, webhook, Evolution, catálogo, claims, RLS, read receipt ou migrations fechadas sem evidência de teste que prove defeito nessa camada.

## 3. PERSONALITY final esperada

Helton é uma única pessoa em E1–E7: especialista em carreiras da Universidade Cruzeiro do Sul.

Tom:

- entusiasmado, acolhedor e próximo;
- carismático, seguro e espontâneo;
- curioso de verdade;
- comercial, com jogo de cintura;
- capaz de enriquecer a fala sem virar texto mecânico ou catálogo.

Nunca parecer formulário, chatbot, script lido ou atendente burocrático.

Regra de reação:

- momento significativo (sonho, objetivo, escolha, oportunidade, história familiar, decisão): reação humana e contextual;
- dado operacional (cidade, telefone, data, nome): condução simples.

Não validar tudo mecanicamente com “Entendi”, “Legal”, “Ótimo”, “Certo” ou “Obrigado”. Pode usar “Perfeito!!”, “Maravilha!!” e “Excelente!!” quando fizer sentido.

Uma pergunta real por vez. Sem emojis. Sem travessão longo. Não narrar processamento interno e nunca mencionar E1, E2, etapa, checkpoint, admin, ferramenta, RAG, catálogo interno, IA ou processamento ao lead.

Nome do agente é Helton. Nunca usar “Helton” como nome do lead. Usar somente primeiro nome pessoal confiável.

## 4. Fluxo comercial desejado

### E1 — conexão e qualificação

Objetivo: resolver curso, cidade e motivação, sem apresentar produto.

Ordem:

1. abertura oficial;
2. identificar o curso;
3. consultar catálogo antes de afirmar disponibilidade ou parabenizar;
4. se houver mais de uma linha real, perguntar qual linha;
5. pedir cidade;
6. entender se já trabalha na área ou qual é o motivo/objetivo;
7. marcar motivação resolvida semanticamente;
8. concluir E1 e entregar somente reação curta/contextual, se houver;
9. iniciar E2 em mensagem separada.

Motivação deve aceitar qualquer razão válida, não apenas “sonho” ou “objetivo”: já trabalha, sempre quis, identificação, família, oportunidade, proposta, mudança de área, crescimento, concurso, afinidade e equivalentes semânticos.

Se a pessoa já explicou a razão, não perguntar novamente. Resposta como “eu já trabalho na área e quero me especializar” resolve motivação.

E1 não fala modalidade, duração, semestres, metodologia, preço, bolsa, tutoria ou grade.

Ao consultar curso:

- curso disponível: resolver internamente; não dizer “consultei catálogo” nem expor disponibilidade técnica;
- curso com linhas múltiplas: mostrar apenas linhas reais e esperar escolha;
- curso indisponível: preservar o interesse e oferecer alternativas reais do mesmo segmento, ou perguntar outra área/curso sem inventar;
- pedido amplo de cursos: perguntar área, listar opções reais, depois retornar ao fluxo normal.

E1 é considerada fechada e não deve ser reaberta sem ordem explícita do administrador.

### E2 — vacinas comerciais

Ordem exata, sem critérios extras:

1. disponibilidade futura;
2. decisor;
3. combinado comercial.

Vacina 1: perguntar se há viagem longa ou mudança planejada nos próximos meses que possa interferir no início da graduação. Resposta negativa resolve e leva diretamente à vacina 2. Resposta positiva pode receber orientação baseada na modalidade real do curso e depois segue para vacina 2.

Vacina 2: perguntar se a pessoa decide sozinha ou conversa com alguém. Aceitar respostas naturais como “eu mesmo”, “só eu”, “converso com meu marido”, “falo com minha esposa”, “decidimos juntos” e equivalentes.

Se houver terceiro decisor, reagir de forma curta e natural, sem elogio excessivo, sem repetir pergunta e sem travar o combinado. A forma precisa respeitar gênero e pessoa mencionada.

Vacina 3: combinado direto, preservando a lógica:

- se não fizer sentido ou não encaixar no orçamento, a pessoa pode dizer não sinceramente;
- se fizer sentido e a bolsa ficar boa, seguir para inscrição e garantir a oportunidade;
- pedir confirmação “Combinado?”.

“Depende do valor” ou equivalente mantém o combinado pendente; não conclui E2 automaticamente. Confirmação natural resolve.

E2 fechada não deve ser reaberta sem ordem explícita.

### E3 — apresentação do produto

Objetivo: gerar desejo e segurança, apresentar curso e instituição com personalidade e responder dúvidas sem loop.

Mudança final desejada:

1. enviar sempre a imagem fixa de apresentação da instituição;
2. apresentar o curso de forma clara, entusiasmada e coesa;
3. conectar o curso ao motivo coletado em E1, naturalmente;
4. informar duração em semestres e anos, modalidade e estágio quando aplicável;
5. fazer pergunta final da apresentação;
6. se a pessoa perguntar algo sobre a graduação, responder diretamente com fatos autorizados em uma ou duas mensagens, conforme a dúvida;
7. não reapresentar tudo, não avançar só porque perguntou e não entrar em loop.

A instituição deve ser apresentada pela imagem fixa `supabase/functions/whatsapp-sender/assets/informacao-instituicao.jpeg`, embutida também em `institution-image-data.ts` para reduzir risco de arquivo ausente.

A imagem contém os principais diferenciais: tradição de mais de 60 anos, conceito institucional máximo no MEC, diploma reconhecido no Brasil e internacionalmente, Universidade Cruzeiro do Sul Virtual, plataforma Blackboard, tutoria próxima e flexibilidade semipresencial/EAD.

Apresentação do curso deve usar dados reais do catálogo/knowledge:

- nome oficial;
- duração em semestres e anos;
- modalidade real;
- conexão com a motivação do lead;
- tutoria e apoio quando autorizados;
- informação de estágio.

Regra de estágio:

- todas as licenciaturas têm estágio;
- todos os bacharelados da área de saúde têm estágio;
- demais cursos não têm estágio, salvo dado explícito diferente no catálogo;
- com estágio: dizer que pode ser realizado na cidade da pessoa caso ela não tenha condições de se deslocar ao polo semipresencial;
- sem estágio: apresentar como vantagem, dizendo que não precisa se preocupar com deslocamento para essa etapa.

A apresentação deve ficar em imagem + dois ou três blocos textuais naturais. Não listar todos os diferenciais como tópicos crus nem gerar blocos excessivos. A PERSONALITY deve costurar as informações.

A pergunta final definida anteriormente pelo administrador é, em essência: “De todos esses pontos que eu te apresentei, [nome], quais foram os pontos que você mais gostou e mais fizeram sentido para você?”. O texto ativo deve ser conferido no prompt do banco antes de qualquer alteração, porque há versões documentadas com pergunta de dúvida específica.

Quando houver dúvida/objeção sobre aula, duração, modalidade, tutoria, diploma, estágio ou curso, responder somente o ponto perguntado, usando fatos autorizados. E3 não fala preço/desconto; interesse financeiro encaminha para E4.

E3 fechada não deve ser reaberta para alterar apresentação sem ordem explícita, exceto a implementação específica da imagem/estágio descrita acima.

### E4 — proposta, retomada e fechamento financeiro

Ao receber interesse financeiro ou concluir E3:

1. pedir nome completo;
2. explicar que a proposta não gera compromisso;
3. dizer que será um documento com informações e condições da bolsa;
4. enviar ao administrador a mensagem interna padronizada;
5. pausar o lead no checkpoint `proposal_send`;
6. aguardar confirmação correta do administrador;
7. confirmar ao administrador que entendeu e vai retomar;
8. retomar a conversa com o lead;
9. enviar/relacionar a proposta ao curso, à motivação da E1 e ao decisor da E2;
10. perguntar se consegue responder até o fim do dia para garantir a oportunidade;
11. tratar objeção real; se não for objeção, registrar prazo e agendar follow-up.

Mensagem interna obrigatória:

```text
Alerta interno: lead solicitou proposta para o curso de [CURSO]

Nome Completo do Lead: [NOME]
Tel: [TELEFONE]
Etapa atual: E4
Curso: [CURSO]

Detalhes
Cidade: [CIDADE]
Motivo: [MOTIVO DA E1]
```

O admin deve confirmar o envio identificando corretamente o lead, preferencialmente respondendo à mensagem administrativa. Não usar “último lead pendente” como correlação insegura. Dois leads não podem cruzar.

Após confirmação, o sistema deve destravar o lead, emitir confirmação ao admin e disparar `stage_handoff` para E4. Mensagens do lead durante pausa podem ser armazenadas, mas não devem ser processadas antes da retomada.

Quando a pessoa pedir matrícula, usar o checkpoint `enrollment_processing`. Só E5 após confirmação administrativa correta.

### E5 — matrícula e boleto

Após confirmação administrativa da matrícula:

- parabenizar pela matrícula;
- perguntar se o boleto será pago hoje ou na próxima segunda-feira;
- aceitar outra data;
- registrar data diferente e notificar admin;
- não afirmar aprovação inexistente;
- após data resolvida, avançar para E6.

### E6 — satisfação e indicação

1. perguntar se gostou do atendimento;
2. perguntar se recomendaria para outra pessoa;
3. se positivo, pedir nome do indicado;
4. pedir telefone do indicado;
5. registrar indicação;
6. se não houver indicação ou a resposta for negativa, aceitar sem insistir;
7. avançar para E7.

Não perguntar curso, área ou cidade do indicado.

### E7 — encerramento

Se houver indicado, informar que a instituição poderá entrar em contato. Sem indicado, encerrar de forma humana. Não reabrir venda, não pedir nova indicação e não requalificar.

## 5. Catálogo, aliases e fatos

Consulta de curso é obrigatória antes de confirmação comercial. O nome digitado pelo lead pode ser apelido.

Implementação:

- tabela de aliases ligada à entrada oficial do curso;
- normalização de caixa, acentos, pontuação e abreviações;
- primeiro procurar curso oficial;
- se não encontrar, procurar `course_catalog_aliases`;
- se encontrar, usar o curso oficial para o restante do fluxo;
- se não encontrar, seguir caminho já definido para indisponível/alternativas.

Aliases cadastrados incluem, entre outros: ADM/Administracao de Empresas, Contador/Contabilidade, ADS, Arquitetura/Arquiteto, Biologia, Economia, Estética, Psicanálise, TI/T.I, Corretor, RH/R.H, Segurança do Trabalho, Assistente Social, TO/T.O, Fono e Óptica/Optica.

O runtime lê entradas estruturadas em `course_catalog_entries` com duração, modalidade, linha, área, aliases e `has_internship`.

## 6. Entrada, áudio, filas e saída

Fluxo técnico:

```text
WhatsApp/Evolution
  -> webhook-receiver
  -> mensagens + fila messages_vendas
  -> debounce-worker
  -> fila ai_processing_vendas
  -> ai-processor/router/subagent
  -> whatsapp-sender
  -> Evolution/WhatsApp
```

Regras:

- debounce consolida mensagens próximas;
- não responder só à primeira mensagem de uma rajada;
- mensagens do próprio agente são ignoradas;
- áudio deve ser baixado pela Evolution e transcrito pelo endpoint de transcrição OpenAI antes da classificação;
- transcrição deve ser salva em `transcricao` e usada como conteúdo do lead;
- falha de download/transcrição deve ser logada, sem inventar o conteúdo do áudio;
- governança divide texto em bolhas sem alterar intenção;
- imagem institucional é enviada pelo sender como mídia, separada dos textos.

Follow-ups rodam pelo `followup-worker`/pg_cron, respeitando horário comercial. Quando lead volta a falar, follow-ups pendentes devem ser cancelados.

## 7. Estado, segurança e checkpoints

Campos e contexto comercial importantes incluem:

- `etapa_atual`;
- `curso_interesse`, linha, modalidade e cidade;
- `dor_principal`/`motivacao_principal`;
- status de disponibilidade, decisor e combinado da E2;
- `course_validated`, `course_status`, `pending_criterion`;
- `has_internship`;
- `proposal_checkpoint_pending/completed`;
- `enrollment_checkpoint_pending/completed`;
- `e4_post_proposal_opening_pending`;
- resposta e prazo de follow-up da proposta;
- `sales_context` e eventos comerciais.

Guards devem bloquear avanço inválido, não substituir personalidade sem necessidade. Governança deve cuidar somente da entrega. Sender não deve decidir etapa.

## 8. Arquivos principais

- `supabase/functions/webhook-receiver/index.ts`: entrada WhatsApp, áudio, admin e enfileiramento.
- `supabase/functions/debounce-worker/index.ts`: consolidação de mensagens.
- `supabase/functions/ai-processor/index.ts`: orquestração, handoff, checkpoints e follow-up.
- `supabase/functions/ai-processor/subagent.ts`: prompt final, personalidade, tools e validações por etapa.
- `supabase/functions/ai-processor/stage-state.ts`: critérios e classificação contextual.
- `supabase/functions/ai-processor/tools.ts`: persistência, avanço, consulta de curso e conhecimento.
- `supabase/functions/ai-processor/catalog-resolver.ts`: intenção e resolução contextual de curso.
- `supabase/functions/ai-processor/e3-presentation.ts`: montagem estrutural atual da apresentação E3.
- `supabase/functions/_shared/admin-checkpoints.ts`: pausa, correlação e retomada administrativa.
- `supabase/functions/_shared/message-governance.ts`: sanitização e divisão de bolhas.
- `supabase/functions/_shared/openai-client.ts`: chamadas OpenAI, incluindo transcrição.
- `supabase/functions/whatsapp-sender/index.ts`: envio de texto/imagem.
- `supabase/functions/whatsapp-sender/institution-image-data.ts`: imagem institucional embutida.
- `scripts/course-catalog-dataset.ts`: dados estruturados e aliases.
- `supabase/migrations/20261112_course_catalog_internship.sql`: regra persistida de estágio.
- `docs/agenthub-canonical-commercial-flow.md`: especificação canônica anterior.

## 9. O que está implementado e evidenciado

Implementado no código atual:

- pipeline WhatsApp, filas, debounce, AI processor e sender;
- roteamento E1–E7;
- classificação contextual para cidade, motivação, decisor, E3 e indicação;
- resolução de curso oficial e aliases;
- consulta estruturada de catálogo;
- cálculo/persistência de estágio por licenciatura e bacharelado de saúde;
- imagem institucional fixa no sender;
- checkpoints administrativos de proposta e matrícula;
- correlação de confirmação por reply/nome, sem cruzar leads;
- retomada automática após confirmação;
- follow-up e cancelamento quando o lead responde;
- transcrição de áudio com múltiplas estratégias de download;
- testes unitários para estado, catálogo, E1, E3, guards, governança e checkpoints.

Registro prático existente em `relatorio-teste-pratico-e2e-2026-11-16.md` mostrou E1, E2, E3 e E4 funcionando até E5; E3 enviou imagem e três blocos textuais com duração, modalidade, motivação e estágio. E6/E7 não foram alcançadas naquela execução por limite de tempo.

Último commit enviado ao GitHub antes deste relatório: `93d270f` (`chore: sync AgentHub workspace`).

## 10. Pendências e pontos que não devem ser escondidos

1. **Prompt ativo do banco:** o runtime usa override salvo em `agent_definitions`; o arquivo `subagent.ts` não prova sozinho qual prompt está ativo no Supabase. Antes de alterar comportamento, ler o prompt real do tenant.
2. **E3:** o builder atual produz imagem + três textos. O objetivo comercial mais recente pede imagem + dois ou três blocos, com curso, motivo, estágio e pergunta. Validar contagem e ordem no WhatsApp real.
3. **Pergunta final E3:** existem versões documentadas para “pontos que mais fizeram sentido” e para “alguma dúvida específica”. Confirmar qual está ativa antes de congelar a etapa.
4. **E2:** manter reação natural ao terceiro decisor e garantir que resposta condicional não conclua combinado.
5. **Áudio:** validar no WhatsApp real que a transcrição corresponde exatamente ao áudio; se falhar, investigar download/mime/Whisper, não alterar regras comerciais.
6. **E4 pós-proposta:** validar no WhatsApp real que a proposta enviada, motivo da E1, decisor da E2, prazo e follow-up aparecem uma vez, na ordem correta.
7. **E6/E7:** o teste prático registrado não percorreu essas etapas; precisam de teste separado antes de declarar ponta a ponta concluído.
8. **Runtime local:** alterações só entram em produção após restart/deploy da função correspondente e confirmação do webhook Evolution.

Não declarar “projeto 100% concluído” sem validar esses pontos.

## 11. Procedimento seguro para outra IA

Antes de editar:

1. ler este arquivo;
2. ler `docs/agenthub-canonical-commercial-flow.md`;
3. consultar prompts ativos em `agent_definitions`;
4. consultar `git status`, branch e último commit;
5. reproduzir o problema com log real;
6. identificar camada responsável;
7. alterar somente essa camada;
8. não reabrir etapa fechada sem ordem explícita;
9. executar apenas testes relacionados;
10. reiniciar/deployar runtime quando a alteração exigir;
11. registrar resultado, falhas e pendências neste relatório ou em relatório de teste separado.

Nunca:

- trocar prompt do dashboard sem autorização;
- corrigir comportamento comercial mexendo em fila/debounce;
- criar frase fixa que substitua a PERSONALITY sem necessidade;
- aceitar confirmação administrativa sem correlação segura;
- considerar ausência de erro no teste local como prova de WhatsApp real;
- afirmar sucesso sem log ou teste correspondente.

## 12. Critério de conclusão final

O projeto só pode ser considerado concluído quando:

- cada etapa E1–E7 seguir a ordem definida;
- E1 aceitar motivação semanticamente e não reabrir pergunta resolvida;
- E2 concluir as três vacinas, incluindo decisor e condição de preço;
- E3 enviar imagem, apresentação personalizada, conexão com motivação, estágio correto e pergunta final sem loop;
- E3 responder dúvidas diretamente sem reapresentação excessiva;
- E4 gerar mensagem administrativa padronizada, pausar e retomar com confirmação correta;
- proposta retomar com motivo E1 e decisor E2, com follow-up adequado;
- E5, E6 e E7 concluírem seus critérios;
- áudio e texto funcionarem no mesmo histórico;
- nenhuma etapa fechada for alterada por regressão;
- unitários, testes de integração e teste prático real apresentarem evidência compatível;
- runtime implantado/reiniciado corresponder ao código e aos prompts ativos.

