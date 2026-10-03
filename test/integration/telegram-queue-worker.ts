import { ConfigService } from '@nestjs/config';
import type { TelegramNotification } from '../../src/generated/client';
import { PrismaService } from '../../src/modules/common/prisma/prisma.service';
import { TelegramService } from '../../src/modules/common/telegram/telegram.service';
import type { TelegramApiAdapter } from '../../src/modules/common/telegram/telegram.service';

type WorkerCommand = { type: 'start' | 'deliver' };

const config = {
  get: (key: string) => (key === 'NODE_ENV' ? 'test' : process.env[key]),
  getOrThrow: (key: string) => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing environment variable: ${key}`);
    return value;
  },
} as ConfigService;
const prisma = new PrismaService(config);
const telegram = new TelegramService(prisma, config);
let claim: TelegramNotification | undefined;
let started = false;
let delivering = false;

process.on('message', (value: unknown) => {
  if (!value || typeof value !== 'object' || !('type' in value)) return;
  const command = value as WorkerCommand;
  if (command.type === 'start' && !started) {
    started = true;
    void claimOne();
  } else if (command.type === 'deliver' && claim && !delivering) {
    delivering = true;
    void deliverClaim();
  }
});

void prisma
  .$connect()
  .then(() => send({ type: 'ready' }))
  .catch((error: unknown) => fail(error));

async function claimOne() {
  try {
    const [row] = await telegram.claimOutboxBatch(1);
    if (!row) {
      send({ type: 'empty' });
      await shutdown();
      return;
    }
    claim = row;
    send({ type: 'claimed', id: row.id });
  } catch (error) {
    await fail(error);
  }
}

async function deliverClaim() {
  if (!claim) return;
  telegram.setApiAdapterForTesting(fakeApi());
  try {
    await telegram.deliverOutboxRow(claim);
    send({ type: 'delivered' });
    await shutdown();
  } catch (error) {
    await fail(error);
  }
}

function fakeApi(): TelegramApiAdapter {
  return {
    sendMessage: () => Promise.resolve({ message_id: 901 } as never),
    editMessageText: () => Promise.resolve(true as never),
    sendDocument: () => Promise.resolve({ message_id: 901 } as never),
    editMessageCaption: () => Promise.resolve(true as never),
    setWebhook: () => Promise.resolve(true as never),
    deleteWebhook: () => Promise.resolve(true as never),
    getUpdates: () => Promise.resolve([]),
  } as unknown as TelegramApiAdapter;
}

function send(message: { type: string; id?: string; error?: string }) {
  process.send?.(message);
}

async function fail(error: unknown) {
  send({
    type: 'error',
    error: error instanceof Error ? error.message : 'Unknown worker error',
  });
  await shutdown();
  process.exitCode = 1;
}

async function shutdown() {
  await prisma.$disconnect();
  process.disconnect?.();
}
