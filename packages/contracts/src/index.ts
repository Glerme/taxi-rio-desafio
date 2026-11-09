import type { Channel, ConfirmChannel, Options } from 'amqplib';
import type Redis from 'ioredis';

export const EXCHANGE = 'corridas';
export const ROUTING_KEYS = {
  CRIADA: 'corrida.criada',
  STATUS_ALTERADO: 'corrida.status_alterado',
} as const;
export const WORKER_QUEUE = 'corridas.worker';
export const DLX = 'corridas.dlx';
export const DLQ = 'corridas.worker.dlq';

export async function assertTopology(channel: Channel | ConfirmChannel): Promise<void> {
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DLX, 'fanout', { durable: true });
  await channel.assertQueue(DLQ, { durable: true });
  await channel.bindQueue(DLQ, DLX, '');
  await channel.assertQueue(WORKER_QUEUE, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': DLX,
    },
  });
  await channel.bindQueue(WORKER_QUEUE, EXCHANGE, 'corrida.*');
}

export type CorridaStatus = 'solicitada' | 'aceita' | 'em_andamento' | 'finalizada';

const nextStatus: Record<CorridaStatus, CorridaStatus | null> = {
  solicitada: 'aceita',
  aceita: 'em_andamento',
  em_andamento: 'finalizada',
  finalizada: null,
};

export function canTransition(from: CorridaStatus, to: CorridaStatus): boolean {
  return nextStatus[from] === to;
}

export interface CorridaEvent {
  event_id: string; // UUID.
  type: (typeof ROUTING_KEYS)[keyof typeof ROUTING_KEYS];
  corrida_id: string;
  passageiro_id: string;
  motorista_id: string | null;
  status: CorridaStatus;
  version: number; // Integer starting at 1, incremented by 1 per status change.
  occurred_at: string; // ISO 8601.
}

// Publish on a ConfirmChannel and await broker confirms before considering delivery successful.
export function publishOptions(event: CorridaEvent): Options.Publish {
  return { persistent: true, messageId: event.event_id };
}

export const CORRIDA_TTL_SECONDS = 3600;

export function corridaKey(id: string): string {
  return `corrida:${id}`;
}

const SET_CORRIDA_IF_NEWER = `
local current = redis.call('GET', KEYS[1])
if current and cjson.decode(current).version >= tonumber(ARGV[1]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

// All corrida cache writes must use this atomic version guard.
export async function setCorridaIfNewer<T extends { id: string; version: number }>(
  redis: Redis,
  corrida: T,
): Promise<boolean> {
  if (!Number.isSafeInteger(corrida.version) || corrida.version < 1) {
    throw new RangeError('Corrida version must be a positive safe integer');
  }
  const result = await redis.eval(
    SET_CORRIDA_IF_NEWER,
    1,
    corridaKey(corrida.id),
    corrida.version,
    JSON.stringify(corrida),
    CORRIDA_TTL_SECONDS,
  );
  return result === 1;
}

export const EVENTOS_COLLECTION = 'eventos';
export const EVENTOS_UNIQUE_INDEX = { key: { event_id: 1 as const }, unique: true };

export type Role = 'passageiro' | 'motorista';
export type JwtClaims = { sub: string; role: Role };
