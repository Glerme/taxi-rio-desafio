# Limites

> Rascunho. Revise antes de entregar.

## Escopo implementado

- Parte 1 completa no código: compose com os 8 serviços, API (JWT RS256, idempotência, outbox, cache-aside), worker (Mongo + Redis, tolerante a duplicata, DLQ), UI mínima, 39 testes automatizados e CI verde (lint, testes, build e `docker build` das 3 imagens).
- Partes 2 (observabilidade) e 3 (Kubernetes) não foram feitas.

## Limitações conhecidas

- **Sem validação de ponta a ponta no compose.** O Docker não estava rodando na máquina durante o desenvolvimento. `docker compose up`, os cenários com curl e o fluxo completo pela UI ainda não foram executados.
- **Testes só com mocks.** Nada roda contra MySQL, Redis, Mongo ou RabbitMQ de verdade. Não estão provados com serviço real: o script Lua do cache, a UNIQUE da idempotência sob concorrência real, o `FOR UPDATE SKIP LOCKED` do outbox e a deduplicação pelo índice único do Mongo.
- **Sem retry com backoff.** O worker faz requeue imediato; uma queda curta de Redis ou Mongo pode esgotar as 5 entregas em milissegundos e mandar eventos válidos para a DLQ. Não há rotina para reprocessar a DLQ.
- **Reconexão simples.** O worker encerra o processo se a conexão com o RabbitMQ cair (depende do restart do compose). A API tenta reconectar no próximo ciclo do outbox; isso foi conferido lendo o código, sem teste.
- **Outbox cresce sem limite.** As linhas enviadas nunca são apagadas.
- **Sem `/metrics`.** O Prometheus está configurado para coletar da API e do worker, mas os endpoints ainda não existem (alvos ficam down).
- **UI:** sem testes; botões não ficam desabilitados durante o envio (duplo clique do motorista mostra 409); o polling de 2s pode sobrepor requisições lentas; componentes no estilo shadcn escritos à mão, sem a CLI.
- **Guard de autenticação "aberto por padrão":** uma rota nova sem `@Roles` fica pública. Hoje só `/health` está assim.
- **Tokens de teste embutidos no bundle da UI** (intencional para a demo; são de teste e estão marcados como TEST ONLY).

## Riscos

- A consistência entre MySQL e cache é eventual (~1s). Um `GET` logo depois de um `PATCH` pode mostrar o status anterior.
- A chave de idempotência não expira; a tabela de corridas é também o registro das chaves.
- Regenerar as chaves com o script invalida os tokens já distribuídos.

## Próximos passos

1. Rodar `docker compose up --build` e os cenários de curl do README; repetir duas requisições simultâneas com a mesma chave e republicar um evento pela UI do RabbitMQ.
2. Testes de integração com serviços reais (Testcontainers ou o próprio compose no CI) para Lua, UNIQUE e SKIP LOCKED.
3. Retry com backoff (fila de espera com TTL) antes da DLQ.
4. Parte 2: logs JSON com correlation_id, `/metrics`, tracing com OpenTelemetry, alertas e k6.
5. Parte 3: manifestos Kubernetes com probes, resources e Secrets; KEDA escalando o worker pela fila.
