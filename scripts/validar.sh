#!/usr/bin/env bash
# Valida a Parte 1 contra o compose rodando (docker compose up --build).
# Requer: bash, curl, node, docker compose. Uso: ./scripts/validar.sh
set -uo pipefail
cd "$(dirname "$0")/.."

API=${API:-http://localhost:3000}
UI=${UI:-http://localhost:8080}
RMQ=${RMQ:-http://localhost:15672}
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
FALHAS=0

token() { node -p "require('./keys/tokens.json')['$1']"; }
uuid() { node -p "crypto.randomUUID()"; }
json() { node -p "JSON.parse(require('fs').readFileSync('$BODY','utf8'))$1"; }

# esperado <descrição> <valor esperado> <valor obtido>
esperado() {
  if [ "$2" = "$3" ]; then printf '  ok    %-48s %s\n' "$1" "$3"
  else printf '  FALHA %-48s esperado %s, veio %s\n' "$1" "$2" "$3"; FALHAS=$((FALHAS + 1)); fi
}
http() { curl -s -o "$BODY" -w '%{http_code}' "$@"; }
mysql_q() { docker compose exec -T mysql mysql -utaxi -ptaxi taxi -N -e "$1" 2>/dev/null; }
mongo_q() { docker compose exec -T mongo mongosh taxi --quiet --eval "$1"; }
publicar() { curl -s -u guest:guest -H 'content-type: application/json' -X POST "$RMQ/api/exchanges/%2F/corridas/publish" -d "$1" >/dev/null; }

P1=$(token passageiro-1); P2=$(token passageiro-2); M=$(token motorista-1)
J='Content-Type: application/json'

echo "== API: autenticação, idempotência e fluxo"
K=$(uuid)
esperado "sem token" 401 "$(http -X POST "$API/corridas")"
esperado "token inválido" 401 "$(http -X POST "$API/corridas" -H "Authorization: Bearer ${P1}x")"
esperado "motorista criando corrida" 403 "$(http -X POST "$API/corridas" -H "Authorization: Bearer $M" -H "Idempotency-Key: $K" -H "$J" -d '{"origem":"A","destino":"B"}')"
esperado "POST sem Idempotency-Key" 400 "$(http -X POST "$API/corridas" -H "Authorization: Bearer $P1" -H "$J" -d '{"origem":"A","destino":"B"}')"
esperado "POST cria corrida" 201 "$(http -X POST "$API/corridas" -H "Authorization: Bearer $P1" -H "Idempotency-Key: $K" -H "$J" -d '{"origem":"Centro","destino":"Barra"}')"
ID=$(json .id)
REPLAY=$(curl -s -D - -o /dev/null -X POST "$API/corridas" -H "Authorization: Bearer $P1" -H "Idempotency-Key: $K" -H "$J" -d '{"origem":"Centro","destino":"Barra"}' | tr -d '\r' | grep -ic '^idempotent-replayed: true')
esperado "replay devolve Idempotent-Replayed" 1 "$REPLAY"
esperado "mesma key, outro corpo" 422 "$(http -X POST "$API/corridas" -H "Authorization: Bearer $P1" -H "Idempotency-Key: $K" -H "$J" -d '{"origem":"Centro","destino":"Tijuca"}')"
esperado "passageiro-2 lendo corrida alheia" 403 "$(http "$API/corridas/$ID" -H "Authorization: Bearer $P2")"
esperado "motorista aceita" 200 "$(http -X PATCH "$API/corridas/$ID/status" -H "Authorization: Bearer $M" -H "$J" -d '{"status":"aceita"}')"
esperado "transição inválida (aceita de novo)" 409 "$(http -X PATCH "$API/corridas/$ID/status" -H "Authorization: Bearer $M" -H "$J" -d '{"status":"aceita"}')"
esperado "motorista inicia" 200 "$(http -X PATCH "$API/corridas/$ID/status" -H "Authorization: Bearer $M" -H "$J" -d '{"status":"em_andamento"}')"
esperado "motorista finaliza" 200 "$(http -X PATCH "$API/corridas/$ID/status" -H "Authorization: Bearer $M" -H "$J" -d '{"status":"finalizada"}')"
sleep 2
esperado "passageiro lê a própria corrida" 200 "$(http "$API/corridas/$ID" -H "Authorization: Bearer $P1")"
esperado "status no snapshot" "finalizada v4" "$(json .status) v$(json .version)"

echo "== Concorrência: 10 POSTs simultâneos com a mesma key"
K2=$(uuid)
for _ in $(seq 10); do
  curl -s -o /dev/null -X POST "$API/corridas" -H "Authorization: Bearer $P1" -H "Idempotency-Key: $K2" -H "$J" -d '{"origem":"X","destino":"Y"}' &
done; wait
esperado "linhas no MySQL" 1 "$(mysql_q "SELECT COUNT(*) FROM corridas WHERE idempotency_key='$K2'")"

echo "== Worker: Mongo, cache e duplicata"
esperado "eventos no Mongo (um por passo)" 4 "$(mongo_q "db.eventos.countDocuments({corrida_id:'$ID'})")"
EV=$(mongo_q "JSON.stringify((({_id,received_at,...e})=>e)(db.eventos.findOne({corrida_id:'$ID',version:2})))")
publicar "$(node -e "const e=JSON.parse(process.argv[1]);console.log(JSON.stringify({properties:{delivery_mode:2,message_id:e.event_id},routing_key:e.type,payload:JSON.stringify(e),payload_encoding:'string'}))" "$EV")"
sleep 2
esperado "evento v2 republicado não duplica no Mongo" 4 "$(mongo_q "db.eventos.countDocuments({corrida_id:'$ID'})")"
esperado "evento v2 não sobrescreve o cache v4" 4 "$(docker compose exec -T redis redis-cli GET "corrida:$ID" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")"

echo "== DLQ: mensagem malformada"
dlq() { curl -s -u guest:guest "$RMQ/api/queues/%2F/corridas.worker.dlq" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).messages ?? 0"; }
ANTES=$(dlq)
publicar '{"properties":{},"routing_key":"corrida.criada","payload":"isso nao e json","payload_encoding":"string"}'
sleep 7 # as estatísticas da API de management atualizam a cada ~5s
esperado "DLQ recebeu a mensagem" $((ANTES + 1)) "$(dlq)"

echo "== UI"
esperado "UI responde" 200 "$(http "$UI/")"
esperado "proxy /api da UI" 200 "$(http "$UI/api/corridas" -H "Authorization: Bearer $M")"

echo
if [ "$FALHAS" -eq 0 ]; then echo "Tudo certo."; else echo "$FALHAS falha(s)."; exit 1; fi
