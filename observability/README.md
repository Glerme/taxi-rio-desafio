# Observabilidade

Após iniciar o compose, abra Jaeger em http://localhost:16686 e selecione o serviço
`api` ou `worker`. Ambos exportam traces por OTLP HTTP para `http://jaeger:4318`
na rede interna, sem depender da saúde do coletor. O Jaeger usa memória: os traces
são perdidos ao reiniciar o serviço.

Prometheus: http://localhost:9090/targets mostra os jobs `api`, `worker` e
`rabbitmq`; http://localhost:9090/alerts mostra os dois alertas. Coleta a cada 15s.
O plugin `rabbitmq_prometheus` já vem ativo na imagem `rabbitmq:3-management`;
a porta 15692 fica interna. O scrape usa `/metrics/detailed`,
`family=queue_coarse_metrics` e `vhost=/` para preservar os labels de fila.

Métricas disponíveis:

- API: `http_requests_total{method,route,status_code}`,
  `http_request_duration_seconds` (histograma), `outbox_pending`,
  `outbox_oldest_pending_age_seconds`, `outbox_published_total` e
  `outbox_publish_errors_total`.
- Worker: `worker_messages_total{outcome=processed|duplicate|malformed|failed}`,
  `worker_processing_duration_seconds` e `worker_event_lag_seconds` (histogramas).
- RabbitMQ: `rabbitmq_detailed_queue_messages_ready`,
  `rabbitmq_detailed_queue_messages_unacked` e `rabbitmq_detailed_queue_messages`,
  com labels `vhost` e `queue`.

`ApiTaxaDeErroAlta` (critical) exige mais de 5% de respostas 5xx na janela de 5m,
com tráfego acima de 0,1 req/s, sustentado por 5m. O piso reduz falsos positivos
por requisições isoladas; o tempo evita disparos por falhas transitórias.

`EventosAtrasados` (warning) exige por 2m qualquer sinal: idade do item mais antigo
da outbox acima de 10s, p95 do lag do worker na janela de 5m acima de 10s, ou mais
de 100 mensagens prontas em `corridas.worker`. A calibração com k6 está em
[loadtest/RELATORIO.md](../loadtest/RELATORIO.md), com séries em
`loadtest/results/{baseline,peak}/evidence.json`: a baseline teve idade máxima
de outbox de 0,575s e pior p95 de lag de 3,577s; no pico foram 11,652s e cerca
de 28,969s. Assim, 10s fica acima da baseline nos dois ramos e alcança a região
de degradação do pico. Para o lag, 10s é borda de bucket; ~29s é interpolação
no bucket 10–30s, não uma duração exata. Os percentis coletados usam `rate[1m]`,
enquanto a regra mantém `rate[5m]`: estes dados não comprovam disparo por 2m
na carga real. Os 2m toleram picos breves; a profundidade detecta worker parado
mesmo sem amostras de lag (ready máximo observado: 0 na baseline e 23 no pico).

A alternativa descartada foi alertar por DLQ não vazia: mensagens já isoladas
podem permanecer para investigação sem significar atraso atual do pipeline.
Mantivemos exatamente os dois alertas de disponibilidade e prontidão pedidos.
Não há Alertmanager neste compose; os estados são consultados no Prometheus.

`alerts.yml` é carregado pelo compose; `alerts-prometheusrule.yaml` contém as
mesmas regras para clusters com Prometheus Operator (o seletor de labels deve
incluir esse recurso). Não é necessário Operator no ambiente local.

Validação reproduzível (sem subir compose):

```sh
docker compose config -q
docker run --rm --entrypoint promtool -v "$PWD/observability:/obs:ro" prom/prometheus:v3.7.3 check config /obs/prometheus.yml
docker run --rm --entrypoint promtool -v "$PWD/observability:/obs:ro" prom/prometheus:v3.7.3 check rules /obs/alerts.yml
docker run --rm --entrypoint promtool -v "$PWD/observability:/obs:ro" prom/prometheus:v3.7.3 test rules /obs/alerts.test.yml
```
