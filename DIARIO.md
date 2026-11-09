# Diário de desenvolvimento

> Rascunho montado a partir do histórico da execução. Revise e complete com a sua voz: o que você pensou, o que estranhou.

## 2026-11-09

**Planejamento**
- Li o enunciado e foquei na Parte 1. Escrevi um plano com as decisões principais (outbox, idempotência em banco + aplicação, fila quorum com DLQ, cache com guarda de versão) antes de qualquer código.
- Quebrei em tarefas que não editam os mesmos arquivos (scaffold, contracts, api, worker, ui) para rodar em paralelo com agentes de IA no Orca, cada uma no seu worktree, com revisão e merge `--no-ff` aprovado por mim.

**Primeiros tropeços**
- A pasta não era repositório git, então worktrees não funcionavam. Fiz `git init` e um commit inicial só com o PDF.
- O Orca tinha registrado o projeto como "folder" (antes do git). Depois do `git init`, reconheceu como git.
- Percebi que todas as tarefas iam mexer no `pnpm-lock.yaml`, o que geraria conflito em todo merge. Decidi que nenhuma tarefa commita o lockfile e eu regenero no main depois de cada merge.
- O daemon do Docker estava parado na máquina. Nenhum agente conseguiu rodar `docker build` nem compose; a validação ficou em build, lint, testes com mocks e boot local (que falha só por falta do MySQL).

**Contracts (11:40–11:46)**
- O pacote de contratos veio com um `self-check.cjs` além dos testes Jest. A revisão apontou que era duplicado e saiu.
- O agente de testes escreveu `index.spec.ts`, mas não commitou. Só vi porque o agente seguinte avisou que o arquivo estava "untracked". Commitei e passei a exigir commit dos testes nas specs seguintes.
- O revisor rodou o script Lua num Redis falso: grava só se a versão for maior, compara número e não string.

**Worker (11:50–11:56)**
- Ajustei o plano: duplicata no Mongo não pode encerrar o processamento, senão uma queda entre Mongo e Redis deixa o cache velho para sempre. O worker segue e aplica o cache (seguro por causa da guarda de versão).
- A revisão reprovou: o Jest apontava para `worker/test`, uma pasta vazia que não vai para o git. Num clone limpo, `pnpm -r test` quebraria. Corrigido.
- Também faltava um teste garantindo a ordem Mongo → cache: dava para inverter no código e tudo continuava verde. Adicionei o teste e o revisor fez um teste de mutação (inverteu a ordem): 2 testes quebraram, como esperado.

**API (11:53–12:10)**
- A revisão aprovou, mas apontou que o `GET /corridas/:id` devolvia 500 quando o Redis caía, mesmo com o MySQL no ar. Agora loga e lê do MySQL.
- O agente tinha deixado um relatório (`VERIFICATION.md`) dentro de `api/`, que iria para a imagem Docker. Removi e adicionei `files: ["dist"]` no `package.json` para a imagem levar só o build.
- O relay do outbox estava sem teste. Adicionei testes para o ponto mais delicado: `sent_at` só é marcado depois do confirm do RabbitMQ. Também testei o 403 de motorista diferente e o 409 de conflito de versão. Ficaram 18 testes.

**UI (11:49)**
- Decisão do agente que mantive: a `Idempotency-Key` é reaproveitada só no "tentar de novo" e é trocada se o formulário mudar, para não reusar a chave com outro corpo (daria 422).

**CI (12:13–13:46)**
- Primeiro push: CI vermelho. O lint (`tsc --noEmit`) rodava antes do build de `contracts`, então o worker não achava o módulo. O revisor do worker já tinha previsto isso. Corrigido rodando o build de contracts logo após o install; criei também um `.dockerignore`.
- Ficou uma dúvida se o `api/Dockerfile` funcionaria com `install --frozen-lockfile` sem os `package.json` da ui e do worker. O CI com `docker build` das 3 imagens passou verde.

**Validação no compose**
- Liguei o Docker e subi tudo com `docker compose up --build`: os 8 serviços subiram e a API ficou saudável na primeira tentativa.
- Rodei os cenários do enunciado com curl: todos com o status esperado. Na primeira rodada, metade "falhou", mas o erro era do meu script (o `require` do Node não lê arquivo sem extensão `.json`, então o id da corrida veio vazio e as rotas viraram 404). Corrigi o script, não a API.
- Testei o que até então só tinha prova com mocks: 10 POSTs simultâneos com a mesma chave geraram 1 linha no MySQL e 1 evento no outbox; republiquei pelo RabbitMQ um evento antigo (version 2) de uma corrida já finalizada, e o Mongo não duplicou nem o cache regrediu; uma mensagem que não era JSON foi para a DLQ.
- A DLQ apareceu com 0 mensagens logo depois do envio. Olhando o log do worker, a mensagem tinha sido rejeitada; o contador da API de management do RabbitMQ só atualiza a cada ~5s.
- Juntei tudo em `scripts/validar.sh` (21 verificações) para poder repetir.
- Vi que a resposta do POST devolve `idempotency_key` e `request_hash`. Não é vazamento, mas anotei no LIMITES.

**Parte 2: Operar**
- Antes de quebrar as tarefas, percebi que o trace morreria no outbox: o relay publica fora da request. Decidi gravar o `traceparent` no outbox e fazer a propagação explícita até o worker.
- O revisor do worker achou que o pnpm 12 bloqueia o script de build do `protobufjs` (trazido pelo OTel), e o `pnpm install --frozen-lockfile` do Dockerfile ia quebrar. Ele confirmou num diretório temporário que `allowBuilds: { protobufjs: false }` no `pnpm-workspace.yaml` resolve; o script só confere versão.
- O SDK do OTel liga por padrão exporters de logs e métricas. Cada linha do pino ia para o Jaeger, que só aceita traces. Desliguei nos dois serviços.
- O revisor da API viu que cada tick do relay gerava ~4 traces raiz de MySQL (8 por segundo), que poluiriam o Jaeger. Agora o trabalho de banco do relay roda com tracing suprimido; só o span de publish, ligado à request, aparece.
- Subi o compose de novo: o `validar.sh` continuou 21/21, e um `POST /corridas` gerou um trace com 16 spans da API ao worker, com o mesmo `trace_id` nos logs dos dois.

**k6**
- Execução de referência (até 10 corridas/s): 0% de erro, p95 de 215ms. Pico (até 32 corridas/s, ~195 req/s oferecidas): 0% de erro, mas p95 de 950ms, 1.112 eventos parados no outbox e atraso p95 de ~29s.
- O gargalo é o relay: 50 eventos a cada 500ms (~100/s) contra 128 eventos/s oferecidos no pico. A fila do RabbitMQ chegou só a 23 e o worker processa em poucos ms: a espera acontece antes do broker.
- O alerta `EventosAtrasados` (30s) não disparou com 29s de atraso. O limiar estava frouxo demais para "quase em tempo real". Calibrei para 10s com os números do teste.
- Um trace do pico mostrou o INSERT no outbox levando 545ms contra 0,25ms do INSERT em corridas. A hipótese é contenção com o relay, que segura a transação enquanto espera o confirm do RabbitMQ. Não medi lock waits, então ficou como hipótese.

**Uso de IA**
- Toda a implementação foi feita por agentes (Claude, Codex e OpenCode) coordenados no Orca, com um agente revisor separado por tarefa e minha aprovação em cada merge.
