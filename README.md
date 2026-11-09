# Taxi.Rio: serviço de corridas

Passageiro solicita uma corrida, motorista aceita, inicia e finaliza. A API grava no MySQL e publica eventos no RabbitMQ; o worker grava o histórico no MongoDB e atualiza o cache de status no Redis.

```
[UI React] ──HTTP+JWT──▶ [API NestJS] ──▶ MySQL (corridas + outbox)
                              │
                              └─ outbox ─▶ RabbitMQ ─▶ [Worker] ─▶ MongoDB (eventos)
                                                          └──────▶ Redis (status)
```

Decisões e trade-offs: [DECISIONS.md](DECISIONS.md) · Diário: [DIARIO.md](DIARIO.md) · O que ficou de fora: [LIMITES.md](LIMITES.md)

## Subir

Requer Docker com Compose.

```bash
docker compose up --build
```

| Serviço | Endereço |
|---|---|
| UI | http://localhost:8080 |
| API | http://localhost:3000 (`GET /health`) |
| RabbitMQ (management) | http://localhost:15672 (guest / guest) |
| Prometheus | http://localhost:9090 (`/targets`, `/alerts`) |
| Jaeger | http://localhost:16686 |

As migrations do MySQL rodam no start da API. A topologia do RabbitMQ (exchange, fila, DLQ) é criada no boot da API e do worker.

## Validar

Com o compose de pé, em outro terminal (requer `node` e `curl` no host):

```bash
./scripts/validar.sh
```

O script testa, contra os serviços reais: 401 sem token e com token inválido, 403 de role e de corrida alheia, 400 sem `Idempotency-Key`, replay idempotente (201 + `Idempotent-Replayed: true`), 422 com mesma chave e outro corpo, fluxo completo com 409 em transição inválida, 10 POSTs simultâneos com a mesma chave (1 linha no MySQL), evento duplicado e mais antigo republicado no RabbitMQ (não duplica no Mongo nem regride o cache), mensagem malformada indo para a DLQ, e a UI com o proxy `/api`.

### Fluxo pela UI

1. Abra http://localhost:8080 e entre com **passageiro1@taxi.rio** e senha **taxi123**.
2. Crie uma corrida (origem e destino).
3. Saia e entre como **motorista1@taxi.rio** (mesma senha): aceite, inicie e finalize.
4. Volte como passageiro1@taxi.rio: o status acompanha (polling de 2s).

### Na mão, com curl

```bash
P1=$(node -p "require('./keys/tokens.json')['passageiro-1']")
M=$(node -p "require('./keys/tokens.json')['motorista-1']")

# criar (repita o mesmo comando: volta a mesma corrida com Idempotent-Replayed: true)
curl -i -X POST localhost:3000/corridas \
  -H "Authorization: Bearer $P1" -H "Idempotency-Key: minha-chave-1" \
  -H 'Content-Type: application/json' -d '{"origem":"Centro","destino":"Barra"}'

# aceitar (troque <id> pelo id retornado)
curl -i -X PATCH localhost:3000/corridas/<id>/status \
  -H "Authorization: Bearer $M" -H 'Content-Type: application/json' -d '{"status":"aceita"}'

# ler (snapshot de status, vem do cache)
curl -s localhost:3000/corridas/<id> -H "Authorization: Bearer $P1"
```

## API

As rotas de corridas exigem `Authorization: Bearer <jwt>`.

| Método e rota | Quem | Respostas |
|---|---|---|
| `POST /auth/login` | público | 200 `{token}` · 401 `{message: "Credenciais inválidas"}` |
| `POST /corridas` | passageiro | 201 · 201 + `Idempotent-Replayed: true` · 400 (sem `Idempotency-Key` ou corpo inválido) · 401 · 403 · 422 (mesma chave, outro corpo) |
| `PATCH /corridas/:id/status` | motorista | 200 · 401 · 403 (role, ou outro motorista) · 404 · 409 (transição inválida ou conflito de versão) |
| `GET /corridas/:id` | ambos | 200 snapshot `{id, passageiro_id, motorista_id, status, version, updated_at}` · 403 (corrida de outro passageiro) · 404 |
| `GET /corridas` | ambos | 200 · passageiro vê as suas; motorista vê as solicitadas e as dele |

Status: `solicitada → aceita → em_andamento → finalizada`.

## Chaves e tokens de teste

`keys/` tem um par RSA e três JWTs RS256 (`passageiro-1`, `passageiro-2`, `motorista-1`, válidos por 10 anos) em `keys/tokens.json`. **São só de teste**, gerados por `node scripts/gen-keys-tokens.mjs` (regerar invalida os tokens anteriores). A API recebe a chave pública para validar tokens e a privada para emitir tokens de login, somente neste ambiente de teste.

## Usuários de teste e login

A migration cria estes usuários; a senha de todos é `taxi123` (armazenada com scrypt e salt aleatório).

| Email | sub | role |
|---|---|---|
| passageiro1@taxi.rio | passageiro-1 | passageiro |
| passageiro2@taxi.rio | passageiro-2 | passageiro |
| motorista1@taxi.rio | motorista-1 | motorista |

```bash
curl -s localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"passageiro1@taxi.rio","password":"taxi123"}'
```

Use o campo `token` retornado como `Authorization: Bearer <token>`. O JWT RS256 expira em 8h; os tokens estáticos continuam válidos. Email ou senha inválidos, usuário inexistente e campos inválidos recebem o mesmo 401. O login aceita email e senha como strings não vazias, com limites de 255 e 128 caracteres.

A migration é aditiva e preserva usuários existentes em uma repetição após falha parcial; seu rollback remove a tabela `users` e suas credenciais, sem alterar corridas.

## Estrutura

```
api/                 NestJS: rotas, JWT, idempotência, outbox, cache-aside
worker/              NestJS standalone: consome eventos, grava Mongo e Redis
ui/                  Vite + React + Tailwind, servida por nginx com proxy /api
packages/contracts/  o que API e worker combinam: fila, evento, transições, cache Lua
observability/       configuração do Prometheus
scripts/             gerar chaves/tokens e validar o ambiente
```

Monorepo com pnpm workspaces: cada serviço declara só as dependências que usa (imagens menores) e o contrato compartilhado fica num pacote só.

## Observabilidade (Parte 2)

- **Logs:** JSON (pino) na API e no worker, com `trace_id` e `span_id` em toda linha. O `trace_id` é o correlation id: o mesmo valor aparece no log da API, no log do worker e no Jaeger. Para seguir uma corrida: `docker compose logs api worker | grep <corrida_id>`.
- **Trace:** crie uma corrida e procure o serviço `api`, operação `POST /corridas`, em http://localhost:16686. O trace segue pelo outbox (`corridas publish`) até o worker (`corridas process`, com Mongo e Redis).
- **Métricas:** `GET localhost:3000/metrics` (API) e `worker:3001/metrics` (worker, dentro da rede do compose). Profundidade da fila vem do plugin Prometheus do RabbitMQ. Detalhes e nomes em [observability/README.md](observability/README.md).
- **Alertas:** `observability/alerts.yml` (carregado pelo Prometheus, veja http://localhost:9090/alerts) e `observability/alerts-prometheusrule.yaml` (mesmas regras como PrometheusRule). Justificativa dos dois alertas e dos limiares: [DECISIONS.md](DECISIONS.md), entrada 8.
- **Carga:** script e relatório em [loadtest/](loadtest/RELATORIO.md).

## Testes e CI

```bash
pnpm install
pnpm --filter contracts build   # api e worker dependem do build dos contracts
pnpm -r lint                    # tsc --noEmit
pnpm -r test                    # Jest: contracts 14, api 28, worker 15
pnpm -r build
```

O GitHub Actions roda essa sequência e o `docker build` das três imagens a cada push e PR.

## Uso de IA

O código foi escrito por agentes de IA (Claude Code, Codex e OpenCode) coordenados no Orca. Eu escrevi o plano e as decisões de arquitetura, quebrei o trabalho em tarefas que não editavam os mesmos arquivos e revisei e aprovei cada merge. Cada tarefa passou ainda por um agente revisor separado (Claude Opus).

Exemplos de sugestões rejeitadas ou corrigidas:

- **Duplicata no worker.** O plano inicial dizia "evento duplicado → ack sem efeito". Corrigi antes de implementar: se o worker cair entre gravar no Mongo e atualizar o Redis, a reentrega seria descartada e o cache ficaria velho para sempre. O worker agora segue e reaplica o cache, o que é seguro por causa da guarda de versão.
- **Cache derrubando leitura.** A primeira versão do `GET /corridas/:id` devolvia 500 quando o Redis caía, mesmo com o MySQL no ar. A revisão pegou; agora ela lê do MySQL.
- **Testes que não testavam.** Os testes do worker passavam mesmo invertendo a ordem Mongo → cache no código. Exigi um teste de ordem e conferi com um teste de mutação.
- **Arquivos que não deviam existir.** Um agente criou um `self-check.cjs` que duplicava os testes; outro deixou um relatório dentro de `api/` que iria para a imagem Docker. Os dois saíram.
