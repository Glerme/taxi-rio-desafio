# Verificação da API

Implementado exclusivamente em `api/**`, sem testes `.spec.ts` ou mudanças em `api/test/**`.
O lockfile local mudou durante a instalação e não integra os commits; o coordenador deve regenerá-lo após o merge.

## Saída observada

```text
$ pnpm --filter contracts build
$ tsc -p tsconfig.json
(exit 0)

$ pnpm --filter api build
$ tsc -p tsconfig.build.json
(exit 0)

$ pnpm --filter api lint
$ tsc --noEmit
(exit 0)

$ pnpm --filter api test
$ jest --passWithNoTests
No tests found, exiting with code 0

$ pnpm --filter api deploy --prod /tmp/taxi-api-final-deploy
Packages are copied from the content-addressable store to the virtual store.
Progress: resolved 204, reused 203, downloaded 0, added 204, done
Done in 107ms using pnpm v12.18.0

$ node /tmp/taxi-api-selfcheck.cjs
PASS: HTTP auth/validation, idempotency/replay/422/UNIQUE race, ownership, snapshot, status/version conflict, outbox event count (mock persistence/cache).

$ node /tmp/taxi-relay-selfcheck.cjs
WARN [OutboxRelay] Outbox will retry: broker nack
PASS: relay topology, batch/lock mode, persistent/messageId, confirms before sent_at, retry after nack, reconnection, no overlapping cycle, shutdown (mock broker/database).

$ docker info --format '{{.ServerVersion}}'
failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory

$ JWT_PUBLIC_KEY_PATH="$PWD/keys/public.pem" node api/dist/main.js
LOG [NestFactory] Starting Nest application...
LOG [InstanceLoader] TypeOrmModule dependencies initialized
ERROR [TypeOrmModule] Unable to connect to the database. Retrying (1)...
AggregateError [ECONNREFUSED]
ERROR [ExceptionHandler] AggregateError [ECONNREFUSED]
Error: connect ECONNREFUSED ::1:3306
Error: connect ECONNREFUSED 127.0.0.1:3306
(exit 1)
```

Os self-checks temporários não fazem parte dos commits, respeitando a divisão de ownership dos testes.
O check HTTP usa controller, guard JWT RS256, serviço e servidor Nest reais; DataSource e Redis são mocks em memória.
O check do relay usa conexão/canal AMQP e DataSource simulados, verificando ordem de confirmação, seleção bloqueada e retry.
A simulação de UNIQUE verifica a recuperação da exceção, sem provar concorrência real do MySQL.

## Integração e invariantes

- `AppModule` exportado em `src/app.module.ts`; `CorridasService` e `CorridasController` em seus arquivos correspondentes.
- `AuthGuard`, `Roles` e `CurrentUser` em `src/auth.ts`; `Corrida` e `Outbox` em `src/entities.ts`.
- `CacheService` e `OutboxRelay` em `src/infrastructure.ts`; `OutboxRelay.tick()` permite check isolado do ciclo.
- Hash sobre `JSON.stringify({ origem, destino })`, sem normalizar silenciosamente os valores.
- UNIQUE por passageiro/chave; colisão relida depois do rollback; corrida/evento na mesma transação.
- Update por id/version; versão incrementada; evento inserido na mesma transação.
- Toda gravação do snapshot usa `setCorridaIfNewer`; leitura cache-aside preserva autorização por passageiro.
- Relay usa transação com `FOR UPDATE SKIP LOCKED`, lote 50 e confirmação antes de `sent_at`.
- Dockerfile usa contexto raiz, respeita `.npmrc` e depende do lockfile regenerado no merge.

## Pulado/riscos

Sem paginação, Swagger, métricas ou outros itens de Parte 2; nenhum teste pertencente à outra tarefa foi escrito.
Sem daemon Docker: não foi possível executar compose/curl com dependências reais, validar SQL de migrations/locks no MySQL, nem construir a imagem Docker.
O boot compilado alcança a conexão com MySQL e falha apenas por ausência dessa dependência.
A entrega de outbox é pelo menos uma vez: falha após confirmação e antes do commit pode republicar o mesmo `event_id`, exigindo deduplicação no worker conforme o contrato.
Snapshots podem ficar defasados até o worker processar eventos; indisponibilidade do Redis pode fazer a leitura do snapshot falhar.
A tarefa de testes deve adicionar arquivos em `api/test/` ou manter esse diretório para satisfazer os roots do Jest em um checkout limpo.
