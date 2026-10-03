import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { Bot, CommandContext, Context, GrammyError, InputFile } from 'grammy';
import type { Update } from 'grammy/types';
import {
  LessonStatus,
  NotificationType,
  Prisma,
  Role,
  TelegramLinkKind,
  TelegramNotification,
  TelegramRecipientKind,
  TelegramUpdateInbox,
} from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../../core/users/users.service';

export const MAX_ATTEMPTS = 5;
const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const OUTBOX_LEASE_MS = 5 * 60 * 1000;
const INBOX_LEASE_MS = 5 * 60 * 1000;
const API_TIMEOUT_SECONDS = 40;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;
const ALLOWED_UPDATES = [
  'message',
  'my_chat_member',
  'callback_query',
] as const;

export type InlineKeyboard = {
  inline_keyboard: { text: string; callback_data: string }[][];
};

export type TelegramRecipient = {
  kind: TelegramRecipientKind;
  id: string;
};

export type TelegramOutboxEvent = {
  recipient: TelegramRecipient;
  occurrenceKey: string;
  type: NotificationType;
  entityId?: string;
  text: string;
  replyMarkup?: InlineKeyboard | null;
};

export type TelegramApiAdapter = Pick<
  Bot['api'],
  | 'sendMessage'
  | 'editMessageText'
  | 'sendDocument'
  | 'editMessageCaption'
  | 'setWebhook'
  | 'deleteWebhook'
  | 'getUpdates'
>;

type DbClient = PrismaService | Prisma.TransactionClient;
type RecipientBinding = { chatId: string; bindingVersion: number };
type ClaimedInboxUpdate = TelegramUpdateInbox;

@Injectable()
export class TelegramService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TelegramService.name);
  readonly bot?: Bot;
  private readonly webhookUrl?: string;
  private readonly webhookSecret?: string;
  private readonly isProduction: boolean;
  private apiOverride?: TelegramApiAdapter;
  private flushing = false;
  private pollingAbort?: AbortController;
  private pollingTask?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.webhookUrl = config.get<string>('TELEGRAM_WEBHOOK_URL') || undefined;
    this.webhookSecret =
      config.get<string>('TELEGRAM_WEBHOOK_SECRET') || undefined;
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
    if (this.webhookUrl && !this.webhookSecret) {
      throw new Error('TELEGRAM_WEBHOOK_SECRET is required with webhook');
    }

    const token = config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return;
    this.bot = new Bot(token, {
      client: { timeoutSeconds: API_TIMEOUT_SECONDS },
    });
    this.bot.command('start', (ctx) => this.onStart(ctx));
    this.bot.on('message:migrate_to_chat_id', (ctx) =>
      this.migrateChat(String(ctx.chat.id), String(ctx.msg.migrate_to_chat_id)),
    );
    this.bot.on('my_chat_member', async (ctx) => {
      const { status } = ctx.myChatMember.new_chat_member;
      if (status === 'left' || status === 'kicked') {
        await this.deactivateChat(String(ctx.chat.id));
      }
    });
    this.bot.catch((error) => {
      this.logger.error('Telegram update failed');
      throw error;
    });
  }

  get enabled() {
    return !!this.bot;
  }

  get readiness() {
    if (!this.bot) return 'disabled';
    return this.bot.isInited() ? 'ready_optional' : 'degraded_optional';
  }

  get api(): TelegramApiAdapter | undefined {
    return this.apiOverride ?? this.bot?.api;
  }

  /** Installs a controlled API adapter for tests without making network calls. */
  setApiAdapterForTesting(adapter: TelegramApiAdapter) {
    this.apiOverride = adapter;
  }

  /** Initializes webhook delivery or starts durable local polling. */
  async onApplicationBootstrap() {
    if (!this.bot) return;
    try {
      await this.bot.init();
      if (this.webhookUrl) {
        await this.api!.setWebhook(this.webhookUrl, {
          secret_token: this.webhookSecret,
          allowed_updates: ALLOWED_UPDATES,
        });
      } else if (this.isProduction) {
        this.logger.warn(
          'Telegram polling is disabled in production; configure a webhook',
        );
      } else {
        await this.api!.deleteWebhook({ drop_pending_updates: false });
        this.startDurablePolling();
      }
    } catch {
      this.logger.error('Telegram bot initialization failed');
    }
  }

  async onModuleDestroy() {
    this.pollingAbort?.abort();
    await this.pollingTask;
    if (this.bot?.isRunning()) await this.bot.stop();
  }

  isValidWebhookSecret(secret: string | undefined) {
    if (!this.webhookSecret || !secret) return false;
    const a = Buffer.from(secret);
    const b = Buffer.from(this.webhookSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Persists an incoming Telegram update before the webhook can return 200. */
  async acceptWebhookUpdate(update: Update) {
    await this.persistUpdate(update);
  }

  /** Persists an update for retryable background processing. */
  async handleUpdate(update: Update) {
    await this.acceptWebhookUpdate(update);
  }

  private async persistUpdate(update: Update) {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      throw new Error('Invalid Telegram update id');
    }
    await this.prisma.telegramUpdateInbox.createMany({
      data: [
        {
          updateId: BigInt(update.update_id),
          payload: update as unknown as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
  }

  async createGroupLink(studentId: string) {
    this.assertBotReady();
    const token = randomBytes(16).toString('base64url');
    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, studentId);
      const student = await tx.studentProfile.findUnique({
        where: { userId: studentId },
        select: {
          user: { select: { isActive: true } },
          telegramGroup: { select: { bindingVersion: true } },
        },
      });
      if (!student?.user.isActive)
        throw new NotFoundException('Student not found');
      await tx.telegramLinkToken.create({
        data: {
          token,
          kind: TelegramLinkKind.GROUP,
          userId: studentId,
          bindingVersion: student.telegramGroup?.bindingVersion ?? 0,
          expiresAt: new Date(Date.now() + LINK_TTL_MS),
        },
      });
    });
    return this.linkUrl(TelegramLinkKind.GROUP, token);
  }

  async createUserLink(userId: string) {
    this.assertBotReady();
    const token = randomBytes(16).toString('base64url');
    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      const user = await tx.user.findUnique({
        where: { id: userId },
        include: UsersService.profileExists,
      });
      if (
        !user?.isActive ||
        (!user.staffRoles.includes(Role.ADMIN) &&
          !user.staffRoles.includes(Role.MANAGER) &&
          !user.teacherProfile &&
          !user.studentProfile)
      ) {
        throw new NotFoundException('User not found');
      }
      await tx.telegramLinkToken.create({
        data: {
          token,
          kind: TelegramLinkKind.PRIVATE,
          userId,
          bindingVersion: user.telegramBindingVersion,
          expiresAt: new Date(Date.now() + LINK_TTL_MS),
        },
      });
    });
    return this.linkUrl(TelegramLinkKind.PRIVATE, token);
  }

  async unlinkGroup(studentId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, studentId);
      const student = await tx.studentProfile.findUnique({
        where: { userId: studentId },
        select: { userId: true },
      });
      if (student) {
        await tx.telegramGroup.upsert({
          where: { studentId },
          create: {
            studentId,
            telegramChatId: null,
            isActive: false,
            bindingVersion: 1,
          },
          update: {
            telegramChatId: null,
            isActive: false,
            bindingVersion: { increment: 1 },
          },
        });
      }
      await this.cancelRecipient(tx, TelegramRecipientKind.GROUP, studentId);
      await tx.telegramLinkToken.deleteMany({
        where: { userId: studentId, kind: TelegramLinkKind.GROUP },
      });
    });
  }

  async unlinkUser(userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      await tx.user.update({
        where: { id: userId },
        data: {
          telegramChatId: null,
          telegramBindingVersion: { increment: 1 },
        },
      });
      await this.cancelRecipient(tx, TelegramRecipientKind.USER, userId);
      await tx.telegramLinkToken.deleteMany({
        where: { userId, kind: TelegramLinkKind.PRIVATE },
      });
    });
  }

  private assertBotReady() {
    if (!this.bot?.isInited()) {
      throw new ServiceUnavailableException('Telegram is not configured');
    }
  }

  private linkUrl(kind: TelegramLinkKind, token: string) {
    const username = this.bot?.botInfo?.username;
    if (!username) {
      throw new ServiceUnavailableException('Telegram is not configured');
    }
    const param = kind === TelegramLinkKind.GROUP ? 'startgroup' : 'start';
    return {
      url: `https://t.me/${username}?${param}=${token}`,
    };
  }

  private async onStart(ctx: CommandContext<Context>) {
    const token = ctx.match || '';
    const chatId = String(ctx.chat.id);
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    let errorMessage: string | undefined;
    let linkedKind: TelegramLinkKind | undefined;

    try {
      await this.prisma.$transaction(async (tx) => {
        const link = await tx.telegramLinkToken.findUnique({
          where: { token },
        });
        if (!link || link.expiresAt < new Date()) {
          errorMessage =
            'Ссылка недействительна или устарела. Получите новую в личном кабинете или у менеджера.';
          return;
        }
        const isGroupLink = link.kind === TelegramLinkKind.GROUP;
        if (isGroupLink !== isGroup) {
          errorMessage = isGroupLink
            ? 'Эта ссылка для группы ученика: откройте её и выберите группу.'
            : 'Эта ссылка для личного чата с ботом.';
          return;
        }

        await this.lockUser(tx, link.userId);
        const user = await tx.user.findUnique({
          where: { id: link.userId },
          select: {
            isActive: true,
            staffRoles: true,
            telegramBindingVersion: true,
            teacherProfile: { select: { userId: true } },
            studentProfile: { select: { userId: true } },
          },
        });
        if (
          !user?.isActive ||
          (isGroupLink && !user.studentProfile) ||
          (!isGroupLink &&
            !user.staffRoles.some(
              (role) => role === Role.ADMIN || role === Role.MANAGER,
            ) &&
            !user.teacherProfile &&
            !user.studentProfile)
        ) {
          errorMessage =
            'У пользователя нет активного доступа. Получите новую ссылку после восстановления доступа.';
          await tx.telegramLinkToken.deleteMany({
            where: { token, bindingVersion: link.bindingVersion },
          });
          return;
        }

        let currentVersion = user.telegramBindingVersion;
        if (isGroupLink) {
          const group = await tx.telegramGroup.findUnique({
            where: { studentId: link.userId },
            select: { bindingVersion: true },
          });
          currentVersion = group?.bindingVersion ?? 0;
        }
        if (
          currentVersion !== link.bindingVersion ||
          link.expiresAt < new Date()
        ) {
          errorMessage =
            'Ссылка недействительна или устарела. Получите новую в личном кабинете или у менеджера.';
          return;
        }

        const consumed = await tx.telegramLinkToken.deleteMany({
          where: {
            token,
            kind: link.kind,
            userId: link.userId,
            bindingVersion: link.bindingVersion,
            expiresAt: { gt: new Date() },
          },
        });
        if (!consumed.count) {
          errorMessage =
            'Ссылка недействительна или уже использована. Получите новую ссылку.';
          return;
        }

        if (isGroupLink) {
          await tx.telegramGroup.upsert({
            where: { studentId: link.userId },
            create: {
              studentId: link.userId,
              telegramChatId: chatId,
              bindingVersion: 1,
              isActive: true,
            },
            update: {
              telegramChatId: chatId,
              isActive: true,
              bindingVersion: { increment: 1 },
            },
          });
          await this.cancelRecipient(
            tx,
            TelegramRecipientKind.GROUP,
            link.userId,
          );
          linkedKind = TelegramLinkKind.GROUP;
        } else {
          await tx.user.update({
            where: { id: link.userId },
            data: {
              telegramChatId: chatId,
              telegramBindingVersion: { increment: 1 },
            },
          });
          await this.cancelRecipient(
            tx,
            TelegramRecipientKind.USER,
            link.userId,
          );
          linkedKind = TelegramLinkKind.PRIVATE;
        }
        await tx.telegramLinkToken.deleteMany({
          where: { userId: link.userId, kind: link.kind },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        errorMessage =
          linkedKind === TelegramLinkKind.GROUP
            ? 'Эта группа уже привязана к другому ученику.'
            : 'Не удалось подключить Telegram.';
      } else {
        throw error;
      }
    }

    if (errorMessage) await ctx.reply(errorMessage);
  }

  /** Updates group binding and cancels work addressed to the old chat. */
  private async migrateChat(from: string, to: string) {
    const groups = await this.prisma.telegramGroup.findMany({
      where: { telegramChatId: from },
      select: { studentId: true },
    });
    for (const { studentId } of groups) {
      await this.prisma.$transaction(async (tx) => {
        await this.lockUser(tx, studentId);
        const changed = await tx.telegramGroup.updateMany({
          where: { studentId, telegramChatId: from, isActive: true },
          data: {
            telegramChatId: to,
            bindingVersion: { increment: 1 },
          },
        });
        if (changed.count) {
          await this.cancelRecipient(
            tx,
            TelegramRecipientKind.GROUP,
            studentId,
          );
        }
      });
    }
  }

  /** Deactivates matching current bindings and cancels their pending outbox work. */
  private async deactivateChat(chatId: string) {
    const [groups, users] = await Promise.all([
      this.prisma.telegramGroup.findMany({
        where: { telegramChatId: chatId, isActive: true },
        select: { studentId: true },
      }),
      this.prisma.user.findMany({
        where: { telegramChatId: chatId },
        select: { id: true },
      }),
    ]);
    for (const { studentId } of groups) {
      await this.prisma.$transaction(async (tx) => {
        await this.lockUser(tx, studentId);
        const changed = await tx.telegramGroup.updateMany({
          where: { studentId, telegramChatId: chatId, isActive: true },
          data: {
            telegramChatId: null,
            isActive: false,
            bindingVersion: { increment: 1 },
          },
        });
        if (changed.count) {
          await this.cancelRecipient(
            tx,
            TelegramRecipientKind.GROUP,
            studentId,
          );
        }
      });
    }
    for (const { id } of users) {
      await this.prisma.$transaction(async (tx) => {
        await this.lockUser(tx, id);
        const changed = await tx.user.updateMany({
          where: { id, telegramChatId: chatId },
          data: {
            telegramChatId: null,
            telegramBindingVersion: { increment: 1 },
          },
        });
        if (changed.count) {
          await this.cancelRecipient(tx, TelegramRecipientKind.USER, id);
        }
      });
    }
  }

  /** Stores an owner-addressed notification in the transactional outbox. */
  async enqueue(
    event: TelegramOutboxEvent,
    db: DbClient = this.prisma,
  ): Promise<void> {
    if (db === this.prisma) {
      await this.prisma.$transaction((tx) =>
        this.enqueueInTransaction(event, tx),
      );
      return;
    }
    await this.enqueueInTransaction(event, db as Prisma.TransactionClient);
  }

  private async enqueueInTransaction(
    event: TelegramOutboxEvent,
    tx: Prisma.TransactionClient,
  ) {
    await this.lockUser(tx, event.recipient.id);
    const binding = await this.resolveBinding(tx, event.recipient);
    if (!binding) return;

    const replyMarkup = event.replyMarkup ?? null;
    const payloadHash = this.hash(this.stableJson([event.text, replyMarkup]));
    const eventKey = this.hash(
      this.stableJson([
        event.type,
        event.entityId ?? null,
        event.occurrenceKey,
        event.recipient.kind,
        event.recipient.id,
        binding.bindingVersion,
      ]),
    );
    const now = new Date();
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "telegram_notifications"
        ("id", "chatId", "type", "entityId", "eventKey", "occurrenceKey",
         "recipientKind", "recipientId", "bindingVersion", "payloadHash",
         "desiredVersion", "deliveredVersion", "text", "replyMarkup",
         "nextAttemptAt", "attempts", "createdAt", "updatedAt")
      VALUES
        (${randomUUID()}, ${binding.chatId}, ${event.type}::"NotificationType",
         ${event.entityId ?? null}, ${eventKey}, ${event.occurrenceKey},
         ${event.recipient.kind}::"TelegramRecipientKind", ${event.recipient.id},
         ${binding.bindingVersion}, ${payloadHash}, 1, 0, ${event.text},
         ${replyMarkup === null ? null : JSON.stringify(replyMarkup)}::jsonb,
         ${now}, 0, ${now}, ${now})
      ON CONFLICT ("eventKey") DO UPDATE SET
        "text" = EXCLUDED."text",
        "replyMarkup" = EXCLUDED."replyMarkup",
        "payloadHash" = EXCLUDED."payloadHash",
        "desiredVersion" = "telegram_notifications"."desiredVersion" + 1,
        "sentAt" = NULL,
        "attempts" = 0,
        "error" = NULL,
        "failedAt" = NULL,
        "canceledAt" = NULL,
        "nextAttemptAt" = ${now},
        "updatedAt" = ${now}
      WHERE "telegram_notifications"."payloadHash" IS DISTINCT FROM EXCLUDED."payloadHash"
    `);
  }

  /** Claims outbox work under short row locks, for delivery outside the transaction. */
  async claimOutboxBatch(limit = 20): Promise<TelegramNotification[]> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + OUTBOX_LEASE_MS);
    return this.prisma.$transaction(async (tx) => {
      await tx.telegramNotification.updateMany({
        where: {
          canceledAt: null,
          failedAt: null,
          attempts: { gte: MAX_ATTEMPTS },
          leaseToken: { not: null },
          leaseExpiresAt: { lte: now },
        },
        data: {
          failedAt: now,
          error: 'telegram_delivery_lease_expired',
          leaseToken: null,
          leaseVersion: null,
          leaseExpiresAt: null,
        },
      });
      const candidates = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "telegram_notifications"
        WHERE "canceledAt" IS NULL AND "failedAt" IS NULL
          AND "deliveredVersion" < "desiredVersion"
          AND "nextAttemptAt" <= ${now}
          AND "attempts" < ${MAX_ATTEMPTS}
          AND ("leaseToken" IS NULL OR "leaseExpiresAt" <= ${now})
        ORDER BY "nextAttemptAt", "createdAt"
        FOR UPDATE SKIP LOCKED
        LIMIT ${Math.max(1, Math.min(limit, 100))}
      `);
      const claimed: TelegramNotification[] = [];
      for (const { id } of candidates) {
        const row = await tx.telegramNotification.findUnique({
          where: { id },
        });
        if (!row) continue;
        const updated = await tx.telegramNotification.update({
          where: { id },
          data: {
            leaseToken: randomUUID(),
            leaseVersion: row.desiredVersion,
            leaseExpiresAt,
            attempts: { increment: 1 },
          },
        });
        claimed.push(updated);
      }
      return claimed;
    });
  }

  /** Delivers one claimed event and conditionally acknowledges its lease version. */
  async deliverOutboxRow(row: TelegramNotification) {
    const api = this.api;
    if (!api || !row.leaseToken || row.leaseVersion === null) return;
    if (!row.recipientKind || !row.recipientId) {
      await this.cancelLease(row);
      return;
    }
    const recipient = {
      kind: row.recipientKind,
      id: row.recipientId,
    } as TelegramRecipient;
    const binding = await this.resolveBinding(this.prisma, recipient);
    if (
      !binding ||
      binding.chatId !== row.chatId ||
      binding.bindingVersion !== row.bindingVersion
    ) {
      await this.cancelLease(row);
      return;
    }
    if (
      row.type === NotificationType.LESSON_REMINDER_DAY ||
      row.type === NotificationType.LESSON_REMINDER_SOON
    ) {
      const lesson = row.entityId
        ? await this.prisma.lesson.findUnique({
            where: { id: row.entityId },
            select: { status: true, scheduledAt: true },
          })
        : null;
      if (
        !lesson ||
        lesson.status !== LessonStatus.SCHEDULED ||
        lesson.scheduledAt.toISOString() !== row.occurrenceKey
      ) {
        await this.cancelLease(row);
        return;
      }
    }

    let sentMessageId = row.telegramMessageId;
    try {
      let noChange = false;
      if (row.type === NotificationType.MATERIAL_ADDED && row.entityId) {
        const material = await this.prisma.material.findUnique({
          where: { id: row.entityId },
          select: { title: true, fileData: true },
        });
        if (!material) {
          await this.cancelLease(row);
          return;
        }
        if (row.telegramMessageId) {
          try {
            await api.editMessageCaption(row.chatId, row.telegramMessageId, {
              caption: row.text,
              parse_mode: 'HTML',
            });
          } catch (error) {
            if (!this.isMessageNotModified(error)) throw error;
            noChange = true;
          }
        } else {
          const sent = await api.sendDocument(
            row.chatId,
            new InputFile(material.fileData, material.title),
            { caption: row.text, parse_mode: 'HTML' },
          );
          sentMessageId = sent.message_id;
        }
      } else if (row.telegramMessageId) {
        try {
          await api.editMessageText(
            row.chatId,
            row.telegramMessageId,
            row.text,
            {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              reply_markup: (row.replyMarkup ?? {
                inline_keyboard: [],
              }) as InlineKeyboard,
            },
          );
        } catch (error) {
          if (!this.isMessageNotModified(error)) throw error;
          noChange = true;
        }
      } else {
        const sent = await api.sendMessage(row.chatId, row.text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_markup: (row.replyMarkup ?? undefined) as
            | InlineKeyboard
            | undefined,
        });
        sentMessageId = sent.message_id;
      }

      const acknowledged = await this.acknowledgeDelivery(row, sentMessageId);
      if (acknowledged && noChange) {
        this.logger.debug('Telegram message already had the requested content');
      }
    } catch (error) {
      await this.recordDeliveryFailure(row, error);
    }
  }

  /** Claims inbox updates in a short transaction. */
  async claimInboxBatch(limit = 20): Promise<ClaimedInboxUpdate[]> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + INBOX_LEASE_MS);
    return this.prisma.$transaction(async (tx) => {
      await tx.telegramUpdateInbox.updateMany({
        where: {
          processedAt: null,
          failedAt: null,
          attempts: { gte: MAX_ATTEMPTS },
          leaseToken: { not: null },
          leaseExpiresAt: { lte: now },
        },
        data: {
          failedAt: now,
          error: 'telegram_update_lease_expired',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      const candidates = await tx.$queryRaw<{ updateId: bigint }[]>(Prisma.sql`
        SELECT "updateId" FROM "telegram_update_inbox"
        WHERE "processedAt" IS NULL AND "failedAt" IS NULL
          AND "nextAttemptAt" <= ${now}
          AND "attempts" < ${MAX_ATTEMPTS}
          AND ("leaseToken" IS NULL OR "leaseExpiresAt" <= ${now})
        ORDER BY "createdAt"
        FOR UPDATE SKIP LOCKED
        LIMIT ${Math.max(1, Math.min(limit, 100))}
      `);
      const claimed: ClaimedInboxUpdate[] = [];
      for (const { updateId } of candidates) {
        const updated = await tx.telegramUpdateInbox.update({
          where: { updateId },
          data: {
            leaseToken: randomUUID(),
            leaseExpiresAt,
            attempts: { increment: 1 },
          },
        });
        claimed.push(updated);
      }
      return claimed;
    });
  }

  /** Runs one persisted update and records success or a retryable failure. */
  async processInboxRow(row: ClaimedInboxUpdate) {
    if (!this.bot?.isInited() || !row.leaseToken) return;
    try {
      await this.bot.handleUpdate(row.payload as unknown as Update);
      await this.prisma.telegramUpdateInbox.updateMany({
        where: {
          updateId: row.updateId,
          leaseToken: row.leaseToken,
          processedAt: null,
          failedAt: null,
        },
        data: {
          processedAt: new Date(),
          leaseToken: null,
          leaseExpiresAt: null,
          error: null,
        },
      });
    } catch (error) {
      const retry = this.retryPlan(error, row.attempts);
      await this.prisma.telegramUpdateInbox.updateMany({
        where: {
          updateId: row.updateId,
          leaseToken: row.leaseToken,
          processedAt: null,
          failedAt: null,
        },
        data: {
          nextAttemptAt: new Date(Date.now() + retry.delayMs),
          failedAt:
            retry.permanent || row.attempts >= MAX_ATTEMPTS ? new Date() : null,
          leaseToken: null,
          leaseExpiresAt: null,
          error: retry.code,
        },
      });
      this.logger.warn(`Telegram update processing failed: ${retry.code}`);
    }
  }

  /** Persists and retries outbox and inbox work; external calls happen after claim transactions. */
  @Interval(5000)
  async flush() {
    if (!this.bot?.isInited() || this.flushing) return;
    this.flushing = true;
    try {
      for (let i = 0; i < 20; i += 1) {
        const [row] = await this.claimOutboxBatch(1);
        if (!row) break;
        await this.deliverOutboxRow(row);
      }
      for (let i = 0; i < 20; i += 1) {
        const [row] = await this.claimInboxBatch(1);
        if (!row) break;
        await this.processInboxRow(row);
      }
    } catch {
      this.logger.error('Telegram queue worker failed');
    } finally {
      this.flushing = false;
    }
  }

  /** Reports bounded queue counts without exposing recipients or payloads. */
  async queueHealth() {
    const [
      pending,
      failed,
      leased,
      expiredLease,
      oldest,
      pendingInbox,
      failedInbox,
      leasedInbox,
    ] = await Promise.all([
      this.prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS count FROM "telegram_notifications"
        WHERE "canceledAt" IS NULL AND "failedAt" IS NULL
          AND "deliveredVersion" < "desiredVersion"
      `),
      this.prisma.telegramNotification.count({
        where: { failedAt: { not: null }, canceledAt: null },
      }),
      this.prisma.telegramNotification.count({
        where: { leaseToken: { not: null }, canceledAt: null },
      }),
      this.prisma.telegramNotification.count({
        where: {
          leaseToken: { not: null },
          leaseExpiresAt: { lte: new Date() },
          canceledAt: null,
        },
      }),
      this.prisma.telegramNotification.findFirst({
        where: { sentAt: null, failedAt: null, canceledAt: null },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.telegramUpdateInbox.count({
        where: { processedAt: null, failedAt: null },
      }),
      this.prisma.telegramUpdateInbox.count({
        where: { failedAt: { not: null } },
      }),
      this.prisma.telegramUpdateInbox.count({
        where: { leaseToken: { not: null }, processedAt: null },
      }),
    ]);
    return {
      pending: Number(pending[0]?.count ?? 0),
      failed,
      leased,
      expiredLease,
      oldestPendingAt: oldest?.createdAt ?? null,
      pendingInbox,
      failedInbox,
      leasedInbox,
    };
  }

  private async acknowledgeDelivery(
    claimed: TelegramNotification,
    telegramMessageId: number | null,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const entityExists = await this.lockEntityForDelivery(tx, claimed);
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "telegram_notifications" WHERE "id" = ${claimed.id}
        FOR UPDATE
      `);
      const current = await tx.telegramNotification.findUnique({
        where: { id: claimed.id },
      });
      if (
        !current ||
        current.leaseToken !== claimed.leaseToken ||
        current.leaseVersion !== claimed.leaseVersion ||
        current.canceledAt
      ) {
        return false;
      }
      const isCurrentVersion = current.desiredVersion === claimed.leaseVersion;
      await tx.telegramNotification.update({
        where: { id: claimed.id },
        data: {
          telegramMessageId,
          ...(isCurrentVersion && {
            deliveredVersion: claimed.leaseVersion!,
            sentAt: new Date(),
            error: null,
            failedAt: null,
          }),
          ...(!isCurrentVersion && { sentAt: null }),
          leaseToken: null,
          leaseVersion: null,
          leaseExpiresAt: null,
        },
      });
      if (isCurrentVersion && entityExists && claimed.entityId) {
        if (claimed.type === NotificationType.LESSON_REPORT) {
          await tx.lessonReport.updateMany({
            where: { id: claimed.entityId },
            data: { sentToTelegram: true },
          });
        } else if (claimed.type === NotificationType.RESCHEDULE_REQUEST) {
          await tx.rescheduleRequest.updateMany({
            where: { id: claimed.entityId },
            data: { sentToTelegram: true },
          });
        } else if (claimed.type === NotificationType.MATERIAL_ADDED) {
          await tx.material.updateMany({
            where: { id: claimed.entityId },
            data: { sentToTelegram: true },
          });
        }
      }
      return isCurrentVersion;
    });
  }

  private async lockEntityForDelivery(
    tx: Prisma.TransactionClient,
    row: TelegramNotification,
  ) {
    if (!row.entityId) return false;
    let found: { id: string }[] = [];
    if (row.type === NotificationType.LESSON_REPORT) {
      found = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "lesson_reports" WHERE "id" = ${row.entityId}
        FOR UPDATE
      `);
    } else if (row.type === NotificationType.RESCHEDULE_REQUEST) {
      found = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "reschedule_requests" WHERE "id" = ${row.entityId}
        FOR UPDATE
      `);
    } else if (row.type === NotificationType.MATERIAL_ADDED) {
      found = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "materials" WHERE "id" = ${row.entityId}
        FOR UPDATE
      `);
    }
    return found.length > 0;
  }

  private async cancelLease(row: TelegramNotification) {
    await this.prisma.telegramNotification.updateMany({
      where: {
        id: row.id,
        leaseToken: row.leaseToken,
        leaseVersion: row.leaseVersion,
      },
      data: {
        canceledAt: new Date(),
        leaseToken: null,
        leaseVersion: null,
        leaseExpiresAt: null,
      },
    });
  }

  private async recordDeliveryFailure(
    row: TelegramNotification,
    error: unknown,
  ) {
    const retry = this.retryPlan(error, row.attempts);
    const terminal = retry.permanent || row.attempts >= MAX_ATTEMPTS;
    const recorded = await this.prisma.telegramNotification.updateMany({
      where: {
        id: row.id,
        leaseToken: row.leaseToken,
        leaseVersion: row.leaseVersion,
        canceledAt: null,
      },
      data: {
        nextAttemptAt: new Date(Date.now() + retry.delayMs),
        failedAt: terminal ? new Date() : null,
        error: retry.code,
        leaseToken: null,
        leaseVersion: null,
        leaseExpiresAt: null,
      },
    });
    if (
      recorded.count &&
      retry.code === 'telegram_api_403' &&
      row.recipientKind &&
      row.recipientId
    ) {
      await this.deactivateRecipient(
        row.recipientKind,
        row.recipientId,
        row.bindingVersion,
        row.chatId,
      );
    }
    this.logger.warn(`Telegram delivery failed: ${retry.code}`);
  }

  private retryPlan(error: unknown, attempts: number) {
    if (error instanceof GrammyError) {
      if (error.error_code === 429) {
        const retryAfter = error.parameters.retry_after;
        return {
          permanent: false,
          code: 'telegram_api_429',
          delayMs:
            typeof retryAfter === 'number'
              ? Math.max(1000, retryAfter * 1000)
              : this.backoff(attempts),
        };
      }
      if (error.error_code >= 400 && error.error_code < 500) {
        return {
          permanent: true,
          code: `telegram_api_${error.error_code}`,
          delayMs: 0,
        };
      }
      return {
        permanent: false,
        code: `telegram_api_${error.error_code}`,
        delayMs: this.backoff(attempts),
      };
    }
    return {
      permanent: false,
      code: 'telegram_network_error',
      delayMs: this.backoff(attempts),
    };
  }

  private backoff(attempts: number) {
    return Math.min(
      MAX_RETRY_DELAY_MS,
      1000 * 2 ** Math.max(0, Math.min(attempts - 1, 12)),
    );
  }

  private isMessageNotModified(error: unknown) {
    return (
      error instanceof GrammyError &&
      error.description.toLowerCase().includes('message is not modified')
    );
  }

  private async deactivateRecipient(
    kind: TelegramRecipientKind,
    id: string,
    bindingVersion: number,
    chatId: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockUser(tx, id);
      if (kind === TelegramRecipientKind.USER) {
        const result = await tx.user.updateMany({
          where: {
            id,
            telegramChatId: chatId,
            telegramBindingVersion: bindingVersion,
          },
          data: {
            telegramChatId: null,
            telegramBindingVersion: { increment: 1 },
          },
        });
        if (result.count) await this.cancelRecipient(tx, kind, id);
      } else {
        const result = await tx.telegramGroup.updateMany({
          where: {
            studentId: id,
            telegramChatId: chatId,
            bindingVersion,
          },
          data: {
            telegramChatId: null,
            isActive: false,
            bindingVersion: { increment: 1 },
          },
        });
        if (result.count) await this.cancelRecipient(tx, kind, id);
      }
    });
  }

  private async resolveBinding(
    db: DbClient,
    recipient: TelegramRecipient,
  ): Promise<RecipientBinding | null> {
    const user = await db.user.findUnique({
      where: { id: recipient.id },
      select: { isActive: true },
    });
    if (!user?.isActive) return null;
    if (recipient.kind === TelegramRecipientKind.USER) {
      const privateUser = await db.user.findUnique({
        where: { id: recipient.id },
        select: {
          isActive: true,
          telegramChatId: true,
          telegramBindingVersion: true,
        },
      });
      if (!privateUser?.isActive || !privateUser.telegramChatId) return null;
      return {
        chatId: privateUser.telegramChatId,
        bindingVersion: privateUser.telegramBindingVersion,
      };
    }

    const profile = await db.studentProfile.findUnique({
      where: { userId: recipient.id },
      select: {
        telegramGroup: {
          select: {
            isActive: true,
            telegramChatId: true,
            bindingVersion: true,
          },
        },
      },
    });
    const group = profile?.telegramGroup;
    if (!group?.isActive || !group.telegramChatId) return null;
    return {
      chatId: group.telegramChatId,
      bindingVersion: group.bindingVersion,
    };
  }

  private async cancelRecipient(
    tx: Prisma.TransactionClient,
    kind: TelegramRecipientKind,
    id: string,
  ) {
    const now = new Date();
    await tx.$executeRaw(Prisma.sql`
      UPDATE "telegram_notifications"
      SET "canceledAt" = ${now}, "leaseToken" = NULL,
          "leaseVersion" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = ${now}
      WHERE "recipientKind" = ${kind}::"TelegramRecipientKind"
        AND "recipientId" = ${id} AND "canceledAt" IS NULL
        AND "failedAt" IS NULL
        AND "deliveredVersion" < "desiredVersion"
    `);
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE
    `);
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private stableJson(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableJson(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      const sorted = Object.entries(value as Record<string, unknown>).sort(
        ([left], [right]) => left.localeCompare(right),
      );
      return `{${sorted.map(([key, item]) => `${JSON.stringify(key)}:${this.stableJson(item)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  }

  private startDurablePolling() {
    if (!this.api || this.pollingTask) return;
    this.pollingAbort = new AbortController();
    this.pollingTask = this.pollUpdates(this.pollingAbort.signal).finally(
      () => {
        this.pollingTask = undefined;
      },
    );
  }

  private async pollUpdates(signal: AbortSignal) {
    let offset: number | undefined;
    while (!signal.aborted) {
      try {
        // A single process owns polling; updates are persisted before offset advances.
        const updates = await this.api!.getUpdates({
          ...(offset !== undefined && { offset }),
          timeout: 25,
          allowed_updates: ALLOWED_UPDATES,
        });
        for (const update of updates) {
          await this.persistUpdate(update);
          offset = update.update_id + 1;
        }
      } catch {
        if (signal.aborted) return;
        this.logger.warn('Telegram durable polling failed');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}
