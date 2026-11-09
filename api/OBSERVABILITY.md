# P2-1 — evidências de observabilidade

A API inicia `tracing.ts` antes dos outros imports. O SDK usa `OTEL_SERVICE_NAME`
(default `api`) e a configuração padrão do exporter OTLP HTTP, incluindo
`OTEL_EXPORTER_OTLP_ENDPOINT` (na infra: `http://jaeger:4318`). AMQP não recebe
instrumentação automática: o enqueue persiste W3C traceparent/tracestate; o relay
restaura esse contexto e injeta o contexto do novo span PRODUCER nos headers.
O `trace_id` é o correlation_id dos logs. O span de publicação termina depois da
transação com confirmação; falhas registram erro e mantêm o retry existente.

O endpoint público `/metrics` publica os nomes exigidos. HTTP usa templates de
rota e exclui `/metrics`; os gauges do outbox são atualizados por uma agregação
COUNT/MIN por tick, inclusive quando a conexão com o broker falha, sem query no
scrape. `outbox_published_total` conta eventos confirmados cuja marcação foi
commitada; `outbox_publish_errors_total` conta ciclos de publicação com falha.

## Verificado

- `pnpm --filter contracts build`: passou.
- `pnpm --filter api build`: passou.
- `pnpm --filter api lint`: passou (TypeScript strict).
- `pnpm --filter api test --runInBand`: 2 suites, 18 testes passaram.
- Boot real, sem MySQL/RabbitMQ/Redis/Jaeger: tracing carregou sem erro de import,
  produziu JSON e encerrou no erro esperado de conexão MySQL.
- Smoke assertivo temporário (`/tmp/p2-api-smoke.cjs`), com Nest/HTTP reais e
  DB/broker simulados: contexto salvo, mesmo trace e novo span no header AMQP,
  tracestate preservado, opções persistentes, sent_at somente após confirmação,
  falha de confirmação mantendo pendência e incrementando erros, idade positiva
  da pendência e reset dos gauges quando vazio, respostas sem campos internos,
  rotas parametrizadas sem IDs e exclusão do scrape.
- Esse smoke completou com exporter apontado para `http://127.0.0.1:1` e
  `OTEL_BSP_SCHEDULE_DELAY=50`, sem encerrar a API por falha de exportação.
- `git diff --check`: passou.

Início do boot real:

```json
{"level":30,"context":"NestFactory","msg":"Starting Nest application..."}
{"level":30,"context":"InstanceLoader","msg":"TypeOrmModule dependencies initialized"}
{"level":50,"context":"TypeOrmModule","msg":"Unable to connect to the database. Retrying (1)..."}
```

Trecho real do smoke (campos de processo/tempo omitidos):

```json
{"level":30,"trace_id":"11111111111111111111111111111111","span_id":"5742db92a3e54d3e","event_id":"fbc19338-b09e-4e76-b507-3d10d18b66d7","corrida_id":"11111111-1111-4111-8111-111111111111","msg":"Outbox publication queued for confirmation"}
```

```text
http_requests_total{method="POST",route="/corridas",status_code="201"} 1
http_requests_total{method="PATCH",route="/corridas/:id/status",status_code="200"} 1
http_requests_total{method="GET",route="/corridas/:id",status_code="200"} 1
http_request_duration_seconds_count{method="PATCH",route="/corridas/:id/status",status_code="200"} 1
outbox_pending 0
outbox_oldest_pending_age_seconds 0
outbox_published_total 1
outbox_publish_errors_total 1
```

## Pulado/riscos

- Não alterei testes, worker, contracts, compose ou observability; não rodei compose.
- `api/test/support.ts`: o query builder do FakeDataSource ainda não implementa
  `select`, `addSelect`, `getRawOne` para COUNT/MIN. Os testes antigos passam,
  porém emitem warning de métricas; a tarefa de testes deve cobrir a agregação.
  Nenhum teste quebrou pela remoção dos campos internos.
- Jaeger, MySQL/migration up/down e RabbitMQ reais não foram exercitados nesta
  tarefa; o smoke usou doubles, sem validar exportação no collector.
- O coordenador deve regenerar/integrar `pnpm-lock.yaml` antes do Docker build
  com `--frozen-lockfile`; o lockfile local foi atualizado, mas não commitado.
- pnpm reportou `ERR_PNPM_IGNORED_BUILDS` para `protobufjs@7.6.6`; dependências
  ficaram instaladas e build/lint/test/runtime OTLP passaram. A política de
  scripts precisa ser resolvida no fluxo de instalação integrado.
