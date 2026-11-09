import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate } from 'k6/metrics';

const tokens = JSON.parse(open('../keys/tokens.json'));
const base = __ENV.BASE_URL || 'http://localhost:3000';
const peak = Number(__ENV.PEAK || 10);
const run = __ENV.RUN_ID || String(Date.now());
const replays = new Counter('idempotent_replays');
const conflicts = new Counter('status_conflicts');
const stale = new Rate('stale_final_snapshot');
export const options = {
  scenarios: {
    corridas: {
      executor: 'ramping-arrival-rate', startRate: 1, timeUnit: '1s',
      preAllocatedVUs: 100, maxVUs: 100,
      stages: [
        { duration: '30s', target: Math.ceil(peak / 4) },
        { duration: '60s', target: Math.ceil(peak / 2) },
        { duration: '60s', target: peak },
        { duration: '30s', target: 0 },
      ], gracefulStop: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500'],
    checks: ['rate==1'], dropped_iterations: ['count==0'],
  },
};

export default function () {
  const iteration = exec.scenario.iterationInTest;
  const passenger = tokens[`passageiro-${iteration % 2 + 1}`];
  const headers = { Authorization: `Bearer ${passenger}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${run}-${iteration}` };
  const body = JSON.stringify({ origem: 'Central do Brasil', destino: 'Copacabana' });
  const created = http.post(`${base}/corridas`, body, { headers, tags: { name: 'POST /corridas' } });
  if (!check(created, { 'create 201 + id': r => r.status === 201 && !!r.json('id') })) return;
  const id = created.json('id');
  if (iteration % 10 === 0) {
    const replay = http.post(`${base}/corridas`, body, { headers, tags: { name: 'POST /corridas replay' } });
    replays.add(1);
    check(replay, { 'replay same id + header': r => r.status === 201 && r.json('id') === id && r.headers['Idempotent-Replayed'] === 'true' });
  }
  const read = () => http.get(`${base}/corridas/${id}`, { headers, tags: { name: 'GET /corridas/:id' } });
  check(read(), { 'initial snapshot 200': r => r.status === 200 && r.json('id') === id });
  for (const status of ['aceita', 'em_andamento', 'finalizada']) {
    sleep(0.1);
    const response = http.patch(`${base}/corridas/${id}/status`, JSON.stringify({ status }), {
      headers: { Authorization: `Bearer ${tokens['motorista-1']}`, 'Content-Type': 'application/json' },
      tags: { name: 'PATCH /corridas/:id/status' },
    });
    conflicts.add(response.status === 409 ? 1 : 0);
    if (!check(response, { 'transition 200 + status': r => r.status === 200 && r.json('status') === status })) return;
  }
  const final = read();
  check(final, { 'final snapshot 200': r => r.status === 200 && r.json('id') === id });
  if (final.status === 200) stale.add(final.json('version') < 4);
}
