# Limites

> Rascunho. Revise antes de entregar.

## Escopo implementado

- Parte 1 completa e validada no compose: 8 serviços, API (JWT RS256, idempotência, outbox, cache-aside), worker (Mongo + Redis, tolerante a duplicata, DLQ), UI mínima, 39 testes automatizados, CI verde (lint, testes, build e `docker build` das 3 imagens) e `scripts/validar.sh` com 21 verificações contra os serviços reais.
- Parte 2 feita: logs JSON com `trace_id`, `/metrics` na API e no worker, trace OpenTelemetry da API ao worker atravessando o outbox (Jaeger), 2 alertas (`alerts.yml` + `PrometheusRule`) calibrados com o k6, e teste de carga com relatório (`loadtest/`).
- Parte 3 (Kubernetes) não foi feita. Priorizei uma Parte 1 sólida e a Parte 2 (peso alto) dentro do tempo sugerido de 6 a 8 h. A Parte 3 tem peso médio, e fazê-la às pressas renderia manifestos que eu não conseguiria defender com segurança.

## Limitações conhecidas

- **Testes automatizados só com mocks.** Os 39 testes do Jest não usam MySQL, Redis, Mongo nem RabbitMQ. O comportamento com serviços reais (UNIQUE sob concorrência, guarda de versão do Lua, deduplicação no Mongo, DLQ) é provado pelo `scripts/validar.sh` contra o compose, mas ele roda à mão e não está no CI.
- **`FOR UPDATE SKIP LOCKED` não foi exercitado com concorrência.** Com uma instância só da API, nunca há dois relays disputando as mesmas linhas do outbox.
- **Sem retry com backoff.** O worker faz requeue imediato; uma queda curta de Redis ou Mongo pode esgotar as 5 entregas em milissegundos e mandar eventos válidos para a DLQ. Não há rotina para reprocessar a DLQ.
- **Reconexão simples.** O worker encerra o processo se a conexão com o RabbitMQ cair (depende do restart do compose). A API tenta reconectar no próximo ciclo do outbox; isso foi conferido lendo o código, sem teste.
- **Outbox cresce sem limite.** As linhas enviadas nunca são apagadas.
- **O relay do outbox é o gargalo.** Publica no máximo 50 eventos a cada 500ms (~100/s). No pico do k6 (128 eventos/s oferecidos) o outbox chegou a 1.112 pendentes e o atraso p95 a ~29s. Não ajustei lote/intervalo; ficou documentado em `loadtest/RELATORIO.md`.
- **Contenção no INSERT do outbox é hipótese.** Um trace do pico mostra 545ms no INSERT do outbox; a suspeita é o relay segurando a transação durante o confirm. Lock waits não foram medidos.
- **Os alertas nunca dispararam de verdade.** Os testes `promtool` provam a lógica, mas nenhuma falha foi injetada no compose para ver o alerta ir a firing. Os limiares de 10s vêm de uma única máquina compartilhada.
- **Traces não persistem.** O Jaeger roda em memória; reiniciar o container apaga os traces (por isso o k6 guardou os traces citados em `loadtest/results/`).
- **UI:** sem testes; botões não ficam desabilitados durante o envio (duplo clique do motorista mostra 409); o polling de 2s pode sobrepor requisições lentas; componentes no estilo shadcn escritos à mão, sem a CLI.
- **Guard de autenticação "aberto por padrão":** uma rota nova sem `@Roles` fica pública. Hoje só `/health` está assim.
- **A resposta do POST expõe `idempotency_key` e `request_hash`.** São da própria corrida do passageiro, então não vaza nada de terceiros, mas são detalhes internos que deveriam sair da resposta.
- **Tokens de teste embutidos no bundle da UI** (intencional para a demo; são de teste e estão marcados como TEST ONLY).

## Riscos

- A consistência entre MySQL e cache é eventual (~1s). Um `GET` logo depois de um `PATCH` pode mostrar o status anterior.
- A chave de idempotência não expira; a tabela de corridas é também o registro das chaves.
- Regenerar as chaves com o script invalida os tokens já distribuídos.

## Próximos passos

1. Rodar o `scripts/validar.sh` no CI (subir o compose no GitHub Actions) para não depender de execução manual.
2. Testes de integração com serviços reais (Testcontainers) para Lua, UNIQUE e SKIP LOCKED com duas instâncias da API.
3. Retry com backoff (fila de espera com TTL) antes da DLQ.
4. Relay do outbox: medir a duração do tick, testar lote maior/intervalo menor e não segurar a transação durante o confirm; medir o pool do MySQL antes de mexer em conexões.
5. Injetar falhas no compose (parar o worker, derrubar o Redis) para ver os alertas irem a firing.
6. Parte 3: manifestos Kubernetes com probes, resources e Secrets; KEDA escalando o worker pela fila.
