# Validação P2-3

Compose principal não foi alterado em execução.

## docker compose config -q

```sh
docker compose config -q
```

```text
(sem saída)
exit code: 0
```

## promtool check rules

```sh
docker run --rm --entrypoint promtool -v "$PWD/observability:/obs:ro" prom/prometheus:v3.7.3 check rules /obs/alerts.yml
```

```text
Checking /obs/alerts.yml
  SUCCESS: 2 rules found


exit code: 0
```

## promtool check config

```sh
docker run --rm --entrypoint promtool -v "$PWD/observability:/obs:ro" prom/prometheus:v3.7.3 check config /obs/prometheus.yml
```

```text
Checking /obs/prometheus.yml
  SUCCESS: 1 rule files found
 SUCCESS: /obs/prometheus.yml is valid prometheus config file syntax

Checking /obs/alerts.yml
  SUCCESS: 2 rules found


exit code: 0
```

## promtool test rules

```sh
docker run --rm --entrypoint promtool -v "$PWD/observability:/obs:ro" prom/prometheus:v3.7.3 test rules /obs/alerts.test.yml
```

```text
  SUCCESS


exit code: 0
```

## Plugin ativo

```sh
docker exec taxi-rio-rabbitmq-1 rabbitmq-plugins list -e
```

```text
Listing plugins with pattern ".*" ...
 Configured: E = explicitly enabled; e = implicitly enabled
 | Status: * = running on rabbit@06340c9a5234
 |/
[e*] rabbitmq_federation       3.13.7
[E*] rabbitmq_management       3.13.7
[e*] rabbitmq_management_agent 3.13.7
[E*] rabbitmq_prometheus       3.13.7
[e*] rabbitmq_web_dispatch     3.13.7

exit code: 0
```

## Endpoint detalhado real

```sh
curl -fsS 'http://172.21.0.6:15692/metrics/detailed?family=queue_coarse_metrics&vhost=%2F'
```

```text
# TYPE rabbitmq_detailed_queue_messages_ready gauge
# HELP rabbitmq_detailed_queue_messages_ready Messages ready to be delivered to consumers
rabbitmq_detailed_queue_messages_ready{vhost="/",queue="corridas.worker.dlq"} 2
rabbitmq_detailed_queue_messages_ready{vhost="/",queue="corridas.worker"} 0

exit code: 0
```

## Equivalência

```sh
python3 -c 'import yaml; from pathlib import Path; assert yaml.safe_load(Path("observability/alerts.yml").read_text())["groups"] == yaml.safe_load(Path("observability/alerts-prometheusrule.yaml").read_text())["spec"]["groups"]; print("OK: spec.groups == groups")'
```

```text
OK: spec.groups == groups
```

## Jaeger

`timeout 5s docker run --rm jaegertracing/jaeger:2.12.0` iniciou um container descartável sem publicar portas; saída relevante:

```text
No '--config' flags detected, using default All-in-One configuration with memory storage.
Starting HTTP server ... "port": 16686, "addr": ":16686"
Starting HTTP server ... "otelcol.component.id": "otlp" ... "endpoint": "[::]:4318"
Everything is ready. Begin running and processing data.
```

Encerrado pelo timeout após a prova de inicialização (exit 124 esperado).

## Pulado/riscos

Não subi nem reiniciei o compose: integração com métricas/traces novos da API e worker depende das tarefas paralelas. Sem Alertmanager, persistência de traces ou alerta extra de DLQ; traces em memória e limiares iniciais precisam de calibração com carga real.
