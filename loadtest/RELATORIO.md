# Carga Taxi.Rio — P2-4

Execuções reais em 09/11/2026, no compose `taxi-rio` já ativo; nenhum serviço foi reiniciado. Tudo local: Linux x86_64, Ryzen 5 5500 (6 núcleos/12 threads), 31 GiB de RAM, Docker 29.9.3, k6 1.4.2. Máquina compartilhada com outras aplicações: no registro inicial, 22 GiB de RAM usados e 12 GiB de swap usados; não é benchmark de máquina dedicada. Fonte: [ambiente](results/environment.json).

Cada iteração alterna dois passageiros, cria uma corrida com chave única por execução/iteração, repete cerca de 10% dos POSTs com a mesma chave/corpo e verifica identidade e header de replay. Faz um GET inicial, três PATCHs sequenciais pelo mesmo motorista (`aceita → em_andamento → finalizada`, pausas de 100 ms) e GET final: aproximadamente 6,1 requisições e quatro eventos por corrida. Não força transições inválidas; conta 409s separadamente. O GET final verifica resposta/identidade e mede snapshot anterior à versão 4, compatível com cache eventual.

São quatro rampas contínuas de chegada, de 30/60/60/30 segundos, total de 180 s: partida em 1 corrida/s, alvos `ceil(PEAK/4) → ceil(PEAK/2) → PEAK → 0`; até 30 s para concluir iterações iniciadas. Baseline: alvos 3/5/10/0, execução aproximadamente 17:51–17:54 UTC; pico: 8/16/32/0, aproximadamente 17:55–17:58 UTC. O teto oferecido no pico é aproximadamente 195,2 req/s; não é throughput efetivamente sustentado. A baseline iniciou com 30 VUs e alocou até 43; após perdas de iteração, a segunda rodada pré-alocou 100 VUs, configuração final do script.

Mantidos os critérios solicitados: erro HTTP <1% e p95 global <500 ms, mais 100% de checks e nenhuma iteração descartada. **As duas rodadas terminaram; os gates não passaram integralmente:** baseline teve 13 descartes, e pico teve 208 descartes e ultrapassou o p95. Aumentar o threshold esconderia o limite observado.

| Medida real | Baseline (10 corridas/s alvo máximo) | Pico (32 corridas/s alvo máximo) |
|---|---:|---:|
| Corridas concluídas / requisições | 886 / 5.405 | 2.566 / 15.653 |
| HTTP p95 global k6 | 214,78 ms | 949,63 ms |
| Erro HTTP k6 / checks aprovados | 0% / 100% | 0% / 100% |
| Replays / conflitos 409 | 89 / 0 | 257 / 0 |
| Iterações descartadas | 13 | 208 |
| GET /corridas/:id: pior p95 / p99 de janela | 86,25 / 249,84 ms | 1.419,49 / 3.319,44 ms |
| POST /corridas: pior p95 / p99 de janela | 3.785,71 / 4.757,14 ms | 4.379,75 / 5.000,00 ms |
| PATCH /corridas/:id/status: pior p95 / p99 de janela | 501,67 / 4.367,19 ms | 2.825,50 / 4.565,10 ms |
| Maior taxa HTTP observada (janela de 1 min) | 47,62 req/s | 164,76 req/s |
| Maior proporção 4xx+5xx Prometheus | 0% | 0% |
| Máximo outbox_pending / idade mais antiga | 31 / 0,575 s | 1.112 / 11,652 s |
| Pior p95 worker_event_lag_seconds (janela de 1 min) | 3,577 s | 28,969 s |
| Pior p95 processamento worker (janela de 1 min) | 8,57 ms | 6,31 ms |
| Pico RabbitMQ ready, corridas.worker | 0 | 23 |
| GET final ainda anterior à versão 4 | 886/886 (100%) | 2.566/2.566 (100%) |
| ApiTaxaDeErroAlta: pending / firing observado | não / não | não / não |
| EventosAtrasados: pending / firing observado | não / não | não / não |

Os percentis por rota são **máximos de estimativas de histogram_quantile sobre rate de 1 min**, amostradas a cada 5 s; não são percentis globais do teste e por isso podem superar bastante o p95 global do k6. Os buckets HTTP terminam em 5 s antes de +Inf, limitando a precisão da cauda. O bucket de lag entre 10 e 30 s também é largo: 28,969 s é estimativa, não cronômetro de convergência de leitura. Gauges são máximos observados, não máximos contínuos: scrape a cada 15 s pode perder picos. A janela inclui início e cerca de 30 s após o término; rate inicial pode incluir tráfego anterior. O compose é compartilhado: surgiu GET /corridas nas séries, não exercitado pelo k6 e omitido dos percentis acima; métricas Prometheus não isolam este gerador.

O coletor consultou `/api/v1/query` durante a execução (15 s) e ao fim, e `/api/v1/query_range` para toda a janela. As expressões exatas, respostas, timestamps e regras estão em [baseline](results/baseline/evidence.json), [pico](results/peak/evidence.json) e nos arquivos `live.jsonl`. `ALERTS` não teve série pending/firing e ambos os alertas estavam inactive nas regras consultadas. Isso não valida o disparo: as condições não persistiram e `ApiTaxaDeErroAlta` exige cinco minutos de 5xx >5%, além da duração desta carga; `EventosAtrasados` exige dois minutos. Não houve injeção de falhas.

O primeiro limite evidente foi o pipeline do **outbox**, junto com a cauda de latência HTTP: o relay existente tem lote de 50 por tick de 500 ms, capacidade nominal de até 100 eventos/s antes dos custos de transação/confirmação. A demanda máxima oferecida foi 128 eventos/s. No pico o outbox acumulou 1.112 eventos, enquanto a fila ready chegou apenas a 23 e o processamento do worker permaneceu em poucos ms: a espera predominou antes do consumo, não há evidência de saturação sustentada do worker. Na consulta final, outbox, idade e ready voltaram a zero; o contador processed passou de 3.550 para 13.814 na segunda rodada, diferença de 10.264, correspondente aos quatro eventos das 2.566 corridas. Contadores duplicate/malformed já presentes não aumentaram nessa rodada.

No Jaeger, [trace bde456c968fe797c2ce05bf347be7007](http://localhost:16686/trace/bde456c968fe797c2ce05bf347be7007) mostra POST de 666,095 ms: INSERT **na tabela outbox** de 545,830 ms e COMMIT de 117,474 ms; o span de publicação posterior leva 996,166 ms e o worker 2,415 ms. A publicação é assíncrona e não deve ser somada à latência HTTP. Na baseline, [trace efc0c03301c5ebcc429b695992d31ba3](http://localhost:16686/trace/efc0c03301c5ebcc429b695992d31ba3) mostra POST de 3.885,656 ms com START da transação só em +3.857 ms: há espera não detalhada antes da transação. Espera por conexão/pool é hipótese a investigar, não causa comprovada; não houve instrumentação do pool nem perfil de I/O. JSONs dos traces foram preservados em `slow-traces.json`, pois a retenção do Jaeger local é temporária.

**Lag, alerta e contenção — revisão:**

O p95 de lag de **28,97 s** foi estimado com `rate[1m]`; `EventosAtrasados` usa `rate[5m]`, condição **p95 >30 s por 2 min**. Não são janelas equivalentes. Além disso, 30 s é a borda superior do bucket **10–30 s**: interpolar 28,97 s não demonstra p95 real tão próximo de 30 s, e o limiar atual só é ultrapassado quando o quantil entra no bucket seguinte. Proponho **p95 >10 s por 2 min, mantendo rate[5m]**: 10 s é uma borda existente, acima do pior p95 de 3,577 s da baseline e abaixo da região de degradação observada no pico. É um candidato baseado nestes dados, sem prova de disparo nessa janela de 5 min; requer validação posterior. Nenhuma regra foi alterada nesta tarefa.

Os **28,969 s de lag estimado** e **11,652 s de idade máxima do outbox** não são medidas simultâneas da mesma população. A idade é um gauge dos eventos ainda não enviados, atualizado após o tick e observado por scrape de 15 s; o lag é `Date.now()` no worker menos `occurred_at` da API, registrado após persistência/cache e agregado sobre eventos já processados na janela móvel. Inclui tempo antes do commit, outbox, publicação, espera no broker e processamento. Eventos publicados deixam de contar no gauge, mas ainda podem contar no lag. A interpolação no bucket 10–30 s e a janela que conserva eventos antigos também explicam a diferença aparente, sem exigir espera real de 29 s. A fila ready chegou a **23**, e o pior p95 de processamento foi **6,31 ms**: não sustentam atribuir a diferença a processamento lento; profundidade não mede permanência no broker nem mensagens in-flight. API e worker rodam no mesmo host e compartilham relógio do sistema; não foi medida diferença de relógio, nem há evidência de que ela explique a diferença. As amostras não permitem decompor esses tempos por evento.

No trace do pico, o **INSERT em outbox de 545,830 ms**, frente ao INSERT em corridas de **0,250 ms**, é pista de contenção nessa tabela. O relay faz `SELECT ... FOR UPDATE SKIP LOCKED`, mantém a transação durante confirmações do broker e depois executa `UPDATE ... SET sent_at` nas mesmas estruturas de tabela/índice que recebem INSERTs das requisições. `SKIP LOCKED` evita esperar por linhas já bloqueadas na seleção; não elimina toda disputa com INSERT/UPDATE, índices ou I/O. A publicação de **996,166 ms** e o COMMIT HTTP de **117,474 ms** reforçam investigar duração das transações e lock waits; não comprovam bloqueio específico. Não foram coletados lock waits, isolamento efetivo nem perfil de disco, portanto contenção com o relay continua hipótese, não diagnóstico fechado.

Mudaria primeiro o relay: medir duração de tick e experimentar lote maior/intervalo menor, validando locks e custo de COMMIT, sem prometer que só isso resolve a latência. Mediria espera/ocupação do pool MySQL e I/O antes de aumentar conexões ou mudar índices. Não aumentaria prefetch do worker sem evidência: a fila ficou pequena. Manteria os alertas de falha persistente e acrescentaria um orçamento de latência/cache conforme o SLA desejado; os alertas atuais permaneceram inativos mesmo com p95 HTTP acima de 500 ms e backlog. Os 100% de snapshots finais defasados, medidos imediatamente após a escrita, mostram que resposta PATCH concluída não implica cache atualizado; não foi medido tempo até cada GET convergir.

Para repetir na raiz do repositório, com compose já ativo e tokens locais válidos:

```sh
# Diretório de resultados deve ser novo; coleta k6, Prometheus e Jaeger.
python3 loadtest/measure.py nova-baseline 10
python3 loadtest/measure.py novo-pico 32

# Somente k6; saída no terminal, sem gerar os arquivos de results/.
docker run --rm --user "$(id -u):$(id -g)" --network host \
  -v "$PWD:/work:ro" -e PEAK=10 \
  grafana/k6:1.4.2 run /work/loadtest/script.js
```

**Proveniência dos arquivos:** `measure.py` gera `k6.txt`, `live.jsonl`, `evidence.json` e, com UID/GID corrigidos, `summary.json` em cada diretório novo. A baseline histórica usou **30 VUs pré-alocados e chegou a 43 alocados** (até 40 ativos no summary); os comandos acima usam os 100 pré-alocados atuais e não reproduzem essa diferença de configuração. O summary JSON ausente da baseline não foi reconstruído.

`slow-traces.json` foi obtido manualmente após cada carga, consultando `GET http://localhost:16686/api/traces?service=api&operation=POST%20%2Fcorridas&start=<start_em_micros>&end=<end_em_micros>&limit=10&minDuration=500ms`, usando `start`/`end` de `evidence.json` multiplicados por 1.000.000 e convertidos para inteiro. Para repetir essa coleta e o recorte, após uma execução (escolha um trace lento realmente observado; estes IDs são históricos):

```sh
python3 - <<'PYTRACE'
import json, urllib.parse, urllib.request
from pathlib import Path
for label, trace_id in [('baseline', 'efc0c03301c5ebcc429b695992d31ba3'),
                        ('peak', 'bde456c968fe797c2ce05bf347be7007')]:
    folder = Path('loadtest/results') / label
    evidence = json.loads((folder / 'evidence.json').read_text())
    query = urllib.parse.urlencode(dict(service='api', operation='POST /corridas',
        start=int(evidence['start'] * 1e6), end=int(evidence['end'] * 1e6),
        limit=10, minDuration='500ms'))
    with urllib.request.urlopen('http://localhost:16686/api/traces?' + query) as response:
        traces = json.load(response)
    traces['data'] = [t for t in traces['data'] if t['traceID'] == trace_id]
    assert traces['data'], 'Trace expirado ou ID diferente: escolha um ID da nova coleta'
    (folder / 'slow-traces.json').write_text(json.dumps(traces, separators=(',', ':')) + '\n')
    evidence['traces']['data'] = [t for t in evidence['traces']['data'] if t['traceID'] == trace_id]
    (folder / 'evidence.json').write_text(json.dumps(evidence, separators=(',', ':')) + '\n')
PYTRACE
```

Na revisão, esse mesmo filtro foi aplicado **offline aos JSONs já coletados**, sem consultar novamente os serviços: nenhum dos traces originalmente contidos em `evidence.json` era citado, portanto seus arrays `traces.data` ficaram vazios; os envelopes da consulta original foram preservados. Cada `slow-traces.json` mantém integralmente só o trace citado. Apenas esses quatro JSONs foram compactados, sem alterar séries ou outros campos; os demais arquivos foram mantidos. `du -sh loadtest/results` passou de **2,3M para 256K**.

`results/environment.json` foi um snapshot manual durante a baseline, gerado assim (uma nova execução registra o ambiente atual, não recupera o histórico):

```sh
python3 - <<'PYENV'
import datetime, json, platform, subprocess
from pathlib import Path
snapshot = {'collected_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'platform': platform.platform()}
commands = {'cpu': ['lscpu'], 'memory': ['free', '-h'],
    'docker_version': ['docker', 'version', '--format', '{{.Server.Version}}'],
    'containers': ['docker', 'ps', '--format', '{{.Names}} {{.Image}} {{.Status}}'],
    'docker_stats': ['docker', 'stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}']}
for name, command in commands.items():
    snapshot[name] = subprocess.check_output(command, text=True)
Path('loadtest/results/environment.json').write_text(json.dumps(snapshot, indent=2))
PYENV
```

O comando monta o repositório somente para leitura para resolver `open('../keys/tokens.json')`; não copie tokens para o relatório. As execuções criam dados duráveis de teste no compose e não os apagam. A baseline não gravou `summary.json` por permissão do UID padrão da imagem (12345); seu summary textual completo foi preservado em `k6.txt`. O coletor final usa o UID/GID local, e o pico gravou [summary JSON](results/peak/summary.json). Exit code k6 99 indica thresholds violados, não uma execução interrompida.

**baseline — recorte literal do summary k6:**

```text
    CUSTOM
    idempotent_replays.............: 89      0.494442/s
    stale_final_snapshot...........: 100.00% 886 out of 886
    status_conflicts...............: 0       0/s

    HTTP
    http_req_duration..............: avg=57.21ms  min=893.95µs med=8.35ms   max=4.06s p(90)=104.45ms p(95)=214.78ms
      { expected_response:true }...: avg=57.21ms  min=893.95µs med=8.35ms   max=4.06s p(90)=104.45ms p(95)=214.78ms
    http_req_failed................: 0.00%   0 out of 5405
    http_reqs......................: 5405    30.027611/s

    EXECUTION
    dropped_iterations.............: 13      0.072222/s
    iteration_duration.............: avg=651.97ms min=331.72ms med=349.67ms max=6.21s p(90)=991.55ms p(95)=2.66s
    iterations.....................: 886     4.922195/s
    vus............................: 0       min=0          max=40
    vus_max........................: 43      min=30         max=43
```

**peak — recorte literal do summary k6:**

```text
    CUSTOM
    idempotent_replays.............: 257     1.410838/s
    stale_final_snapshot...........: 100.00% 2566 out of 2566
    status_conflicts...............: 0       0/s

    HTTP
    http_req_duration..............: avg=153.59ms min=708.55µs med=10.55ms  max=5.25s  p(90)=294.57ms p(95)=949.63ms
      { expected_response:true }...: avg=153.59ms min=708.55µs med=10.55ms  max=5.25s  p(90)=294.57ms p(95)=949.63ms
    http_req_failed................: 0.00%   0 out of 15653
    http_reqs......................: 15653   85.929366/s

    EXECUTION
    dropped_iterations.............: 208     1.141846/s
    iteration_duration.............: avg=1.23s    min=333.68ms med=372.57ms max=12.57s p(90)=3.5s     p(95)=7.5s
    iterations.....................: 2566    14.086421/s
    vus............................: 1       min=0            max=100
    vus_max........................: 100     min=100          max=100
```

**Pulado/riscos:** sem falhas injetadas, carga distribuída, teste de disputa deliberada/409 ou sondagem até convergência individual do cache. Resultados locais compartilhados não garantem capacidade de produção; os thresholds expõem degradação e os dados de teste permanecem no banco.
