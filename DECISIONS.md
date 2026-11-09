# Decisões técnicas

> Rascunho. Revise cada entrada: preciso conseguir defender todas na entrevista.

## 1. Idempotência no banco e na aplicação

- **Contexto:** reenviar `POST /corridas` com a mesma `Idempotency-Key` não pode criar corrida duplicada, nem quando duas requisições chegam juntas.
- **Alternativas:** só na aplicação (consultar antes de inserir); só no banco (UNIQUE); chave no Redis com TTL.
- **Escolha:** os dois. `UNIQUE (passageiro_id, idempotency_key)` em `corridas` mais `request_hash` (sha256 do corpo canônico). O header é obrigatório (400 sem ele). Mesma chave com mesmo corpo devolve 201 com a corrida original e `Idempotent-Replayed: true`, sem gerar evento novo. Mesma chave com corpo diferente dá 422. Se duas requisições batem na UNIQUE ao mesmo tempo, a perdedora relê a linha e aplica a mesma regra, em vez de devolver 500.
- **Trade-off:** a chave vale para sempre (não expira) e fica no escopo do passageiro. A consulta prévia sozinha teria corrida de concorrência; a UNIQUE sozinha não sabe diferenciar replay de reuso indevido da chave.

## 2. Outbox para gravar no MySQL e publicar no RabbitMQ

- **Contexto:** a API precisa gravar a corrida e publicar o evento. Se fizer as duas coisas separadas, uma queda entre elas perde o evento ou publica um evento de algo que não foi gravado.
- **Alternativas:** publicar depois do commit e torcer; publicar dentro da transação; CDC (Debezium lendo o binlog).
- **Escolha:** tabela `outbox` inserida na mesma transação da corrida. Um loop na API (~500ms) faz `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50`, publica com publisher confirms e só marca `sent_at` depois do confirm.
- **Trade-off:** a entrega é pelo menos uma vez (se cair entre o confirm e o `sent_at`, o evento sai de novo), por isso o worker precisa tolerar duplicata. Também adiciona ~500ms de latência e uma tabela que cresce (não há limpeza das linhas enviadas). CDC seria mais robusto, mas é infraestrutura demais para o escopo.

## 3. Topologia do RabbitMQ

- **Contexto:** dois tipos de evento (`corrida.criada`, `corrida.status_alterado`), um consumidor e entrega pelo menos uma vez.
- **Escolha:** exchange `corridas` do tipo topic; fila `corridas.worker` do tipo **quorum** com bind `corrida.*`, `x-delivery-limit=5` e DLX `corridas.dlx` → `corridas.worker.dlq`. A topologia é declarada por `assertTopology()` em `packages/contracts`, chamada no boot da API e do worker (quem subir primeiro cria). Mensagens persistentes, `message_id = event_id`.
- **Alternativas:** fila clássica com contagem de tentativas no header; exchange direct.
- **Trade-off:** a quorum conta as entregas sozinha e manda para a DLQ, sem código de retry. Por outro lado, o requeue é imediato (sem backoff): uma queda curta de Redis ou Mongo pode esgotar as 5 tentativas em milissegundos e mandar eventos válidos para a DLQ.

## 4. Cache: cache-aside na API, worker escreve, com guarda de versão

- **Contexto:** o enunciado pede que o worker atualize o cache e que o `GET /corridas/:id` leia do cache.
- **Alternativas:** write-through na API; só o worker escreve (a API nunca preenche); cache-aside puro.
- **Escolha:** o worker grava a partir dos eventos e a API faz cache-aside no miss. As duas escritas passam por `setCorridaIfNewer`, um script Lua que só grava se a `version` nova for maior que a guardada (TTL 1h). Isso evita que um evento atrasado ou repetido sobrescreva um estado mais novo.
- **Interpretação:** o enunciado chama o Redis de "cache de status", então o cache guarda um snapshot `{id, passageiro_id, motorista_id, status, version, updated_at}` e é isso que o `GET /corridas/:id` devolve. Origem e destino ficam no MySQL (aparecem no `GET /corridas` e nas respostas de POST/PATCH).
- **Trade-off:** consistência eventual (~1s entre o PATCH e o cache via worker). Se o Redis cair, a API registra o erro e lê do MySQL.

## 5. Worker tolerante a duplicata

- **Contexto:** entrega pelo menos uma vez (outbox + RabbitMQ).
- **Escolha:** ordem fixa: grava no Mongo (`eventos`, índice único em `event_id`), depois atualiza o cache, depois `ack`. Duplicata no Mongo (erro 11000) **não** encerra o processamento: o worker segue e aplica o cache mesmo assim. Mensagem malformada vai direto para a DLQ (nack sem requeue); outros erros fazem nack com requeue.
- **Por quê:** o plano original era "duplicata → ack sem efeito". Isso deixaria o cache desatualizado para sempre se o worker caísse entre gravar no Mongo e atualizar o Redis. Como o cache tem guarda de versão, reaplicar é seguro.

## 6. JWT RS256 com chave pública estática

- **Contexto:** o enunciado aceita token estático com JWKS ou chave pública.
- **Escolha:** RS256 com a chave pública montada na API (`JWT_PUBLIC_KEY_PATH`). O algoritmo é fixo (rejeita `none` e HS256). Claims `sub` e `role` (`passageiro` | `motorista`). Par de chaves e tokens de teste gerados por `scripts/gen-keys-tokens.mjs` e commitados em `keys/`, marcados como TEST ONLY.
- **Alternativa:** JWKS. Permite rotação de chave sem redeploy, mas exige um emissor/endpoint que o desafio não tem.
- **Regras de acesso:** sem token ou token inválido → 401; role errada → 403; passageiro lendo corrida de outro → **403** (não 404: preferi deixar o 403 explícito, como o enunciado pede para demonstrar); motorista lê qualquer corrida; só o motorista que aceitou pode iniciar/finalizar (outro → 403).

## 7. MySQL para corridas, Mongo para eventos

- **MySQL:** fonte da verdade da corrida. Precisa de transação (corrida + outbox), UNIQUE (idempotência) e update otimista (`UPDATE ... WHERE version = ?`, 0 linhas → 409).
- **Mongo:** histórico de eventos/auditoria. Append-only, documento por evento, sem relações; o índice único em `event_id` faz a deduplicação.
- **Trade-off:** dois bancos para operar. Em produção eu avaliaria guardar o histórico no próprio MySQL, mas o enunciado define a stack.

## 8. Se fosse do zero, manteria o RabbitMQ?

> Entrada obrigatória. Rascunho de argumento, ajuste para a sua opinião.

- **Para este fluxo, sim.** O volume é baixo, há um único consumidor por tipo de evento e o que importa é entrega confiável por mensagem: ack/nack, DLQ e limite de entregas nativo (quorum), roteamento por routing key. O RabbitMQ entrega tudo isso pronto e é simples de operar no compose e no Kubernetes (KEDA tem scaler para ele).
- **Quando trocaria:** se precisasse reprocessar o histórico de eventos (replay), ter vários consumidores independentes lendo o mesmo stream ou volume muito alto, iria para Kafka (ou Redpanda). Se já estivesse em cloud gerenciada e quisesse zero operação, SQS + SNS.
- **Alternativa mais simples a considerar:** como o outbox já está no MySQL, um worker lendo o outbox direto dispensaria o broker. Descartei porque acopla o worker ao banco da API.

## Organização do código

- Monorepo com pnpm workspaces: `api/`, `worker/`, `ui/` e `packages/contracts` (tudo que API e worker precisam combinar: nomes de fila, formato do evento, transições, cache Lua).
- NestJS na API e no worker (standalone, sem HTTP). TypeORM com migrations rodando no start (`synchronize` desligado).
- UI com Vite, React, Tailwind e componentes no estilo shadcn/ui.
- `lint` de cada pacote é `tsc --noEmit` (sem ESLint): pega erro de tipo, que é o que mais importa aqui, sem configurar mais uma ferramenta.
