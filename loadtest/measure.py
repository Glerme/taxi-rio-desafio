"""Run disposable k6 against the existing compose; preserve Prometheus/Jaeger evidence."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
label, peak = sys.argv[1:]
output = ROOT / 'results' / label
output.mkdir(parents=True, exist_ok=False)


def get(base, endpoint, **params):
    with urllib.request.urlopen(base + endpoint + '?' + urllib.parse.urlencode(params), timeout=20) as response:
        return json.load(response)


def prom(endpoint, **params):
    result = get('http://localhost:9090', '/api/v1/' + endpoint, **params)
    assert result['status'] == 'success', result
    return result


queries = {
    'p95_by_route': 'histogram_quantile(0.95,sum by (le,method,route)(rate(http_request_duration_seconds_bucket{job="api",route=~"/corridas.*"}[1m])))',
    'p99_by_route': 'histogram_quantile(0.99,sum by (le,method,route)(rate(http_request_duration_seconds_bucket{job="api",route=~"/corridas.*"}[1m])))',
    'error_ratio': 'sum(rate(http_requests_total{job="api",status_code=~"[45].."}[1m])) / sum(rate(http_requests_total{job="api"}[1m]))',
    'request_rate': 'sum(rate(http_requests_total{job="api",route=~"/corridas.*"}[1m]))',
    'outbox_pending': 'outbox_pending',
    'outbox_age': 'outbox_oldest_pending_age_seconds',
    'worker_lag_p95': 'histogram_quantile(0.95,sum by(le)(rate(worker_event_lag_seconds_bucket[1m])))',
    'worker_processing_p95': 'histogram_quantile(0.95,sum by(le)(rate(worker_processing_duration_seconds_bucket[1m])))',
    'queue_ready': 'rabbitmq_detailed_queue_messages_ready{queue="corridas.worker"}',
    'alerts': 'ALERTS{alertname=~"ApiTaxaDeErroAlta|EventosAtrasados"}',
    'worker_outcomes': 'worker_messages_total',
}
start = time.time()
command = ['docker', 'run', '--rm', '--user', f'{os.getuid()}:{os.getgid()}', '--network', 'host', '-v', f'{ROOT.parent}:/work:ro', '-v', f'{output}:/results', '-e', f'PEAK={peak}', '-e', f'RUN_ID={label}-{int(start)}', 'grafana/k6:1.4.2', 'run', '--summary-export=/results/summary.json', '/work/loadtest/script.js']
with (output / 'k6.txt').open('w') as log:
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    with (output / 'live.jsonl').open('w') as live:
        while process.poll() is None:
            sample = {'time': time.time(), 'queries': {name: prom('query', query=query) for name, query in queries.items()}}
            live.write(json.dumps(sample) + '\n')
            live.flush()
            time.sleep(15)
end = time.time()
# Include two post-run scrapes, preserving recovery and short-lived alert states.
time.sleep(30)
finish = time.time()
data = {'start': start, 'end': end, 'finish': finish, 'peak_iterations_s': int(peak), 'exit_code': process.returncode,
        'range': {name: prom('query_range', query=query, start=start, end=finish, step=5) for name, query in queries.items()},
        'instant': {name: prom('query', query=query) for name, query in queries.items()},
        'rules': get('http://localhost:9090', '/api/v1/rules'),
        'traces': get('http://localhost:16686', '/api/traces', service='api', start=int(start*1e6), end=int(end*1e6), limit=20, minDuration='50ms')}
(output / 'evidence.json').write_text(json.dumps(data, indent=2))
print(json.dumps({key: data[key] for key in ['start', 'end', 'exit_code']}))
print((output / 'k6.txt').read_text()[-6000:])
