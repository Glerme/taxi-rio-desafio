# Decisões técnicas

## 1. Idempotência no banco e na aplicação

- **Contexto:** reenviar `POST /corridas` com a mesma `Idempotency-Key` não pode criar corrida duplicada, nem quando duas requisições chegam juntas.
- **Alternativas:** só na aplicação (consultar antes de inserir); só no banco (UNIQUE); chave no Redis com TTL.
- **Escolha:** os dois. `UNIQUE (passageiro_id, idempotency_key)` em `corridas` mais `request_hash` (sha256 do corpo canônico). O header é obrigatório (400 sem ele). Mesma chave com mesmo corpo devolve 201 com a corrida original e `Idempotent-Replayed: true`, sem gerar evento novo. Mesma chave com corpo diferente dá 422. Se duas requisições batem na UNIQUE ao mesmo tempo, a perdedora relê a linha e aplica a mesma regra, em vez de devolver 500 (no compose, 10 POSTs simultâneos com a mesma chave geraram 1 linha).
- **Trade-off:** a chave vale para sempre (não expira) e fica no escopo do passageiro. A consulta prévia sozinha teria corrida de concorrência; a UNIQUE sozinha não sabe diferenciar replay de reuso indevido da chave.

## 2. Outbox para gravar no MySQL e publicar no RabbitMQ

- **Contexto:** a API precisa gravar a corrida e publicar o evento. Se fizer as duas coisas separadas, uma queda entre elas perde o evento ou publica um evento de algo que não foi gravado.
- **Alternativas:** publicar depois do commit e torcer; publicar dentro da transação; CDC (Debezium lendo o binlog).
- **Escolha:** tabela `outbox` inserida na mesma transação da corrida. Um loop na API (~500ms) faz `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 50`, publica com publisher confirms e só marca `sent_at` depois do confirm.
- **Trade-off:** a entrega é pelo menos uma vez (se cair entre o confirm e o `sent_at`, o evento sai de novo), por isso o worker precisa tolerar duplicata. Adiciona ~500ms de latência e uma tabela que cresce (não há limpeza das linhas enviadas). E tem um teto: 50 eventos a cada 500ms, ~100/s. O k6 mostrou que esse é o primeiro gargalo do sistema (entrada 8). CDC seria mais robusto, mas é infraestrutura demais para o escopo.

## 3. RabbitMQ: topologia e entrega pelo menos uma vez

- **Topologia:** exchange `corridas` do tipo topic; fila `corridas.worker` do tipo **quorum** com bind `corrida.*`, `x-delivery-limit=5` e DLX `corridas.dlx` → `corridas.worker.dlq`. Declarada por `assertTopology()` em `packages/contracts`, chamada no boot da API e do worker (quem subir primeiro cria). Mensagens persistentes, `message_id = event_id`.
- **Alternativas:** fila clássica com contagem de tentativas no header; exchange direct.
- **Worker tolerante a duplicata:** ordem fixa: grava no Mongo (`eventos`, índice único em `event_id`), depois atualiza o cache, depois `ack`. Duplicata no Mongo (erro 11000) **não** encerra o processamento: o worker segue e aplica o cache mesmo assim. Malformada vai direto para a DLQ (nack sem requeue); outros erros fazem nack com requeue. O plano original era "duplicata → ack sem efeito", mas isso deixaria o cache velho para sempre se o worker caísse entre o Mongo e o Redis. Como o cache tem guarda de versão, reaplicar é seguro.
- **Trade-off:** a quorum conta as entregas sozinha e manda para a DLQ, sem código de retry. Por outro lado, o requeue é imediato (sem backoff): uma queda curta de Redis ou Mongo pode esgotar as 5 tentativas em milissegundos e mandar eventos válidos para a DLQ.

## 4. Onde cada dado mora: MySQL, Mongo e cache com guarda de versão

- **MySQL:** fonte da verdade da corrida. Precisa de transação (corrida + outbox), UNIQUE (idempotência) e update otimista (`UPDATE ... WHERE version = ?`, 0 linhas → 409).
- **Mongo:** histórico de eventos/auditoria. Append-only, documento por evento, sem relações; o índice único em `event_id` faz a deduplicação.
- **Redis (cache-aside na API, worker escreve):** o worker grava a partir dos eventos e a API preenche no miss. As duas escritas passam por `setCorridaIfNewer`, um script Lua que só grava se a `version` nova for maior que a guardada (TTL 1h): um evento atrasado ou repetido nunca sobrescreve um estado mais novo. Alternativas consideradas: write-through na API; só o worker escrever.
- **Interpretação:** o enunciado chama o Redis de "cache de status", então ele guarda o snapshot `{id, passageiro_id, motorista_id, status, version, updated_at}`, que é o que o `GET /corridas/:id` devolve. Origem e destino ficam no MySQL.
- **Trade-off:** consistência eventual: em carga normal o cache atualiza em menos de 1s, mas no pico do k6 o atraso p95 chegou a ~29s. Se o Redis cair, a API registra o erro e lê do MySQL. São dois bancos para operar; em produção eu avaliaria guardar o histórico no próprio MySQL, mas o enunciado define a stack.

## 5. JWT RS256 com chave pública estática

- **Contexto:** o enunciado aceita token estático com JWKS ou chave pública.
- **Escolha:** RS256 com a chave pública montada na API (`JWT_PUBLIC_KEY_PATH`). O algoritmo é fixo (rejeita `none` e HS256). Claims `sub` e `role` (`passageiro` | `motorista`). Par de chaves e tokens de teste gerados por `scripts/gen-keys-tokens.mjs` e commitados em `keys/`, marcados como TEST ONLY.
- **Alternativa:** JWKS. Permite rotação de chave sem redeploy, mas exige um emissor/endpoint que o desafio não tem.
- **Regras de acesso:** sem token ou token inválido → 401; role errada → 403; passageiro lendo corrida de outro → **403** (não 404: preferi deixar o 403 explícito, como o enunciado pede para demonstrar); motorista lê qualquer corrida; só o motorista que aceitou pode iniciar/finalizar (outro → 403).

## 6. Se fosse do zero, manteria o RabbitMQ?

- **Para este fluxo, sim.** O volume é baixo, há um único consumidor por tipo de evento e o que importa é entrega confiável por mensagem: ack/nack, DLQ e limite de entregas nativo (quorum), roteamento por routing key. O RabbitMQ entrega tudo isso pronto e é simples de operar no compose e no Kubernetes (KEDA tem scaler para ele). No k6, a fila nunca passou de 23 mensagens: o broker não foi o gargalo.
- **Quando trocaria:** se precisasse reprocessar o histórico de eventos (replay), ter vários consumidores independentes lendo o mesmo stream ou volume muito alto, iria para Kafka (ou Redpanda). Se já estivesse em cloud gerenciada e quisesse zero operação, SQS + SNS.
- **Alternativa mais simples a considerar:** como o outbox já está no MySQL, um worker lendo o outbox direto dispensaria o broker. Descartei porque acopla o worker ao banco da API.

## 7. Observabilidade: trace atravessando o outbox, logs e métricas

- **Contexto:** o enunciado pede um trace da API até o worker. A API não publica dentro da request: grava no outbox e o relay publica ~500ms depois, fora do contexto da request. Só com instrumentação automática, o trace terminaria no MySQL e o worker começaria um trace novo.
- **Alternativas:** instrumentação automática do amqplib (não resolve o salto pelo outbox); publicar dentro da request (quebra o motivo do outbox); span links em vez de parent.
- **Escolha:** propagação explícita. As colunas `traceparent`/`tracestate` no outbox guardam o contexto W3C da request, na mesma transação. O relay cria um span PRODUCER filho desse contexto e injeta o contexto dele nos headers AMQP. O worker extrai dos headers, abre um span CONSUMER e roda Mongo + Redis + ack dentro dele. A instrumentação automática do amqplib fica desligada nos dois lados. Resultado: um `POST /corridas` vira um trace só (16 spans) no Jaeger.
- **Correlation id = trace_id.** Logs JSON com pino; o OTel injeta `trace_id` e `span_id` em toda linha. Um id só liga log da API, log do worker e trace, sem inventar um header próprio. Logs nunca incluem `Authorization` nem o corpo.
- **Métricas:** API com `http_requests_total` e `http_request_duration_seconds` por método, rota (o template `/corridas/:id`, nunca a URL com uuid, para não explodir cardinalidade) e status, mais `outbox_pending` e `outbox_oldest_pending_age_seconds`. Worker com `worker_messages_total{outcome}`, `worker_processing_duration_seconds` e `worker_event_lag_seconds` (do `occurred_at` ao processamento). A profundidade da fila vem do plugin Prometheus do RabbitMQ, não do worker: se o worker cair, a métrica continua existindo.
- **Trade-off:** mais código que o automático, mas determinístico e testável. O trabalho de banco do relay roda com tracing suprimido (senão eram ~8 traces órfãos por segundo), e o SDK exporta só traces (por padrão mandaria logs e métricas para o Jaeger, que não os aceita).

## 8. Os dois alertas e seus limiares

- **ApiTaxaDeErroAlta** (critical): mais de 5% de respostas 5xx por 5 min, só avaliado com tráfego acima de 0,1 req/s. É o sintoma direto de passageiro sem conseguir pedir corrida. Os 5 min e o piso de tráfego evitam disparo por um erro isolado de madrugada.
- **EventosAtrasados** (warning): por 2 min, o item mais antigo do outbox está parado há mais de 10s, ou o p95 do atraso dos eventos no worker passa de 10s, ou há mais de 100 mensagens prontas na fila. O produto promete status "em tempo quase real"; esse alerta pega relay, broker ou worker travado antes do usuário reclamar. O ramo da fila existe porque, com o worker parado, não há amostras de atraso.
- **Calibração com o k6:** os limiares começaram em 30s. No pico do k6 o atraso p95 chegou a ~29s e o alerta não disparou, com o status chegando quase meio minuto atrasado. Baixei para 10s: fica acima da execução de referência (idade máxima do outbox 0,6s, atraso p95 3,6s) e abaixo do pico (11,7s e ~29s). 10s também é borda de bucket do histograma, o que deixa o quantil menos dependente de interpolação perto do limiar. Mesmo assim, nesse k6 o alerta não teria disparado: o atraso ficou acima de 10s por só ~70-85s, menos que os 2 min do `for`. Aceitei: o pico do teste durou 60s, e o `for` existe justamente para não acordar ninguém por uma rajada que se resolve sozinha. Uma degradação real e sustentada passaria dos 2 min.
- **Alternativa descartada:** "DLQ não vazia". É importante, mas mensagem na DLQ é consequência (malformada ou 5 falhas seguidas), e os dois alertas escolhidos pegam a causa antes. Seria o terceiro alerta.

## Organização do código

- Monorepo com pnpm workspaces: `api/`, `worker/`, `ui/` e `packages/contracts` (tudo que API e worker precisam combinar: nomes de fila, formato do evento, transições, cache Lua). Cada serviço declara só o que usa, então cada imagem Docker leva só as próprias dependências.
- NestJS na API e no worker (standalone, sem HTTP). TypeORM com migrations rodando no start (`synchronize` desligado).
- UI com Vite, React, Tailwind e componentes no estilo shadcn/ui.
- `lint` de cada pacote é `tsc --noEmit` (sem ESLint): pega erro de tipo, que é o que mais importa aqui, sem configurar mais uma ferramenta.

## 9. Login local apenas para teste

A API agora assina JWTs RS256 de 8h para permitir login com email e senha nos três usuários de teste, mantendo os mesmos `sub` e `role` do guard. A chave privada é montada somente neste ambiente de teste; senhas usam scrypt com salt aleatório e falhas devolvem a mesma mensagem. Em produção, a emissão pertenceria a um provedor de identidade, sem distribuir esta chave privada de teste.
