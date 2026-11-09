# Limites

> Rascunho. Revise antes de entregar.

## Escopo implementado

- Parte 1 completa e validada no compose: 8 serviços, API (JWT RS256, idempotência, outbox, cache-aside), worker (Mongo + Redis, tolerante a duplicata, DLQ), UI mínima, 39 testes automatizados, CI verde (lint, testes, build e `docker build` das 3 imagens) e `scripts/validar.sh` com 21 verificações contra os serviços reais.
- Partes 2 (observabilidade) e 3 (Kubernetes) não foram feitas.

## Limitações conhecidas

- **Testes automatizados só com mocks.** Os 39 testes do Jest não usam MySQL, Redis, Mongo nem RabbitMQ. O comportamento com serviços reais (UNIQUE sob concorrência, guarda de versão do Lua, deduplicação no Mongo, DLQ) é provado pelo `scripts/validar.sh` contra o compose, mas ele roda à mão e não está no CI.
- **`FOR UPDATE SKIP LOCKED` não foi exercitado com concorrência.** Com uma instância só da API, nunca há dois relays disputando as mesmas linhas do outbox.
- **Sem retry com backoff.** O worker faz requeue imediato; uma queda curta de Redis ou Mongo pode esgotar as 5 entregas em milissegundos e mandar eventos válidos para a DLQ. Não há rotina para reprocessar a DLQ.
- **Reconexão simples.** O worker encerra o processo se a conexão com o RabbitMQ cair (depende do restart do compose). A API tenta reconectar no próximo ciclo do outbox; isso foi conferido lendo o código, sem teste.
- **Outbox cresce sem limite.** As linhas enviadas nunca são apagadas.
- **Sem `/metrics`.** O Prometheus está configurado para coletar da API e do worker, mas os endpoints ainda não existem (alvos ficam down).
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
4. Parte 2: logs JSON com correlation_id, `/metrics`, tracing com OpenTelemetry, alertas e k6.
5. Parte 3: manifestos Kubernetes com probes, resources e Secrets; KEDA escalando o worker pela fila.
