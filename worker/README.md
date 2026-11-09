# Worker

NestJS standalone consumer. Requires `MONGO_URL`, `RABBITMQ_URL` and `REDIS_URL`.
Mongo stores contract fields plus `received_at` (a BSON date); duplicate event IDs
still update Redis through the shared atomic version guard. Invalid messages are
rejected without requeue, and infrastructure failures are requeued. SIGTERM
cancels the consumer and drains pending messages before closing connections.
Unexpected AMQP connection/channel closure exits with code 1 for supervisor restart.

Tests can import `processMessage(msg, { channel, collection, redis })` and
`parseEvent(content)` from `src/process-message.ts`. Channel needs `ack`/`nack`,
collection needs `insertOne`, and Redis is passed to the contracts helper.
Jest discovers `.spec.ts` files under `src` and `test`; the tests task owns those files.

Validation performed:

```text
pnpm --filter contracts build
$ tsc -p tsconfig.json
pnpm --filter worker build
$ tsc -p tsconfig.json
pnpm --filter worker lint
$ tsc --noEmit
pnpm --filter worker test -- --runInBand
No tests found, exiting with code 0
pnpm --filter worker deploy --prod /tmp/taxi-worker-deploy-43ebae2f
Done in 458ms using pnpm v12.18.0
PASS production deploy: function function
PASS: duplicate insert, cache repair/snapshot/version seam, malformed events, Mongo/Redis requeue, untrusted _id stripped
```

The last checks used a temporary Node assert script with injected mocks and loaded
contracts/Nest from the production deployment. Redis version ordering in that
check was mocked; the actual atomic Lua behavior requires integration testing.

## Pulado/riscos

No HTTP, metrics, custom retries, reconnection framework, or test files added.
Docker integration and actual SIGTERM/AMQP-loss behavior were not exercised:
Docker is installed, but `docker info` failed with
`dial unix /var/run/docker.sock: connect: no such file or directory`.
The Docker image requires the coordinator's regenerated frozen workspace lockfile;
the locally updated root lockfile is deliberately excluded from commits.
