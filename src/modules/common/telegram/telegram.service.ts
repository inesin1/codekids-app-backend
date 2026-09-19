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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Bot, CommandContext, Context, GrammyError, InputFile } from 'grammy';
import type { Update } from 'grammy/types';
import {
  NotificationType,
  Prisma,
  TelegramLinkKind,
  TelegramNotification,
} from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';

export const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 60_000;
const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const ALLOWED_UPDATES = [
  'message',
  'my_chat_member',
  'callback_query',
] as const;

// type alias для совместимости с Prisma Json
export type InlineKeyboard = {
  inline_keyboard: { text: string; callback_data: string }[][];
};

type OutgoingMessage = {
  text: string;
  replyMarkup?: InlineKeyboard | null;
};

@Injectable()
export class TelegramService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TelegramService.name);
  readonly bot?: Bot;
  private readonly webhookUrl?: string;
  private readonly webhookSecret?: string;
  private flushing = false;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.webhookUrl = config.get<string>('TELEGRAM_WEBHOOK_URL') || undefined;
    this.webhookSecret =
      config.get<string>('TELEGRAM_WEBHOOK_SECRET') || undefined;
    if (this.webhookUrl && !this.webhookSecret) {
      throw new Error('TELEGRAM_WEBHOOK_SECRET is required with webhook');
    }

    const token = config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return;
    this.bot = new Bot(token);
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
    this.bot.catch((err) => this.logger.error('Telegram update failed', err));
  }

  get enabled() {
    return !!this.bot;
  }

  /** Инициализирует бота и запускает webhook или polling. */
  async onApplicationBootstrap() {
    if (!this.bot) return;
    try {
      await this.bot.init();
      if (this.webhookUrl) {
        await this.bot.api.setWebhook(this.webhookUrl, {
          secret_token: this.webhookSecret,
          allowed_updates: ALLOWED_UPDATES,
        });
      } else {
        // bot.start() снимает webhook, поэтому polling только локально
        void this.bot
          .start({ allowed_updates: ALLOWED_UPDATES })
          .catch((e) => this.logger.error('Telegram polling stopped', e));
      }
    } catch (e) {
      this.logger.error('Telegram bot init failed', e);
    }
  }

  async onModuleDestroy() {
    if (this.bot?.isRunning()) await this.bot.stop();
  }

  isValidWebhookSecret(secret: string | undefined) {
    if (!this.webhookSecret || !secret) return false;
    const a = Buffer.from(secret);
    const b = Buffer.from(this.webhookSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async handleUpdate(update: Update) {
    if (!this.bot?.isInited()) return;
    try {
      await this.bot.handleUpdate(update);
    } catch (e) {
      // гасим ошибку, чтобы Telegram не ретраил апдейт
      this.logger.error('Telegram webhook update failed', e);
    }
  }

  async createGroupLink(studentId: string) {
    const student = await this.prisma.studentProfile.findUnique({
      where: { userId: studentId },
    });
    if (!student) throw new NotFoundException('Student not found');
    return this.createLink(TelegramLinkKind.GROUP, studentId);
  }

  async createUserLink(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return this.createLink(TelegramLinkKind.PRIVATE, userId);
  }

  async unlinkGroup(studentId: string) {
    await this.prisma.telegramGroup.deleteMany({ where: { studentId } });
  }

  async unlinkUser(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { telegramChatId: null },
    });
  }

  private async createLink(kind: TelegramLinkKind, userId: string) {
    if (!this.bot?.isInited()) {
      throw new ServiceUnavailableException('Telegram is not configured');
    }
    // 16 байт base64url укладываются в лимит deep link (64 символа)
    const token = randomBytes(16).toString('base64url');
    await this.prisma.telegramLinkToken.create({
      data: {
        token,
        kind,
        userId,
        expiresAt: new Date(Date.now() + LINK_TTL_MS),
      },
    });
    const param = kind === TelegramLinkKind.GROUP ? 'startgroup' : 'start';
    return {
      url: `https://t.me/${this.bot.botInfo.username}?${param}=${token}`,
    };
  }

  private async onStart(ctx: CommandContext<Context>) {
    const link = ctx.match
      ? await this.prisma.telegramLinkToken.findUnique({
          where: { token: ctx.match },
        })
      : null;
    if (!link || link.expiresAt < new Date()) {
      await ctx.reply(
        'Ссылка недействительна или устарела. Получите новую в личном кабинете или у менеджера.',
      );
      return;
    }

    const chatId = String(ctx.chat.id);
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const isGroupLink = link.kind === TelegramLinkKind.GROUP;
    if (isGroupLink !== isGroup) {
      await ctx.reply(
        isGroupLink
          ? 'Эта ссылка для группы ученика: откройте её и выберите группу.'
          : 'Эта ссылка для личного чата с ботом.',
      );
      return;
    }

    try {
      if (isGroupLink) {
        await this.prisma.telegramGroup.upsert({
          where: { studentId: link.userId },
          create: { studentId: link.userId, telegramChatId: chatId },
          update: { telegramChatId: chatId, isActive: true },
        });
      } else {
        await this.prisma.user.update({
          where: { id: link.userId },
          data: { telegramChatId: chatId },
        });
      }
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        await ctx.reply(
          isGroupLink
            ? 'Эта группа уже привязана к другому ученику.'
            : 'Этот Telegram уже подключён к другому пользователю.',
        );
        return;
      }
      throw e;
    }

    await this.prisma.telegramLinkToken.deleteMany({
      where: { token: link.token },
    });
  }

  /** Обновляет chatId при миграции группы в супергруппу. */
  private async migrateChat(from: string, to: string) {
    await this.prisma.$transaction([
      this.prisma.telegramGroup.updateMany({
        where: { telegramChatId: from },
        data: { telegramChatId: to },
      }),
      this.prisma.telegramNotification.updateMany({
        where: { chatId: from },
        data: { chatId: to },
      }),
    ]);
  }

  /** Деактивирует чат при блокировке бота или удалении из группы. */
  private async deactivateChat(chatId: string) {
    await this.prisma.telegramGroup.updateMany({
      where: { telegramChatId: chatId },
      data: { isActive: false },
    });
    await this.prisma.user.updateMany({
      where: { telegramChatId: chatId },
      data: { telegramChatId: null },
    });
  }

  /** Ставит исходящее сообщение в очередь отправки. */
  async enqueue(
    msg: OutgoingMessage & {
      chatId: string;
      type: NotificationType;
      entityId?: string;
    },
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    await db.telegramNotification.create({
      data: { ...msg, replyMarkup: msg.replyMarkup ?? Prisma.DbNull },
    });
  }

  /** Обновляет еще не отправленное сообщение в очереди. */
  async updateMessage(
    type: NotificationType,
    entityId: string,
    msg: OutgoingMessage,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const { count } = await db.telegramNotification.updateMany({
      where: { type, entityId },
      data: {
        text: msg.text,
        replyMarkup: msg.replyMarkup ?? Prisma.DbNull,
        sentAt: null,
        attempts: 0,
        error: null,
      },
    });
    return count;
  }

  // in-memory флаг для защиты от параллельного выполнения в рамках одного инстанса
  @Interval(5000)
  async flush() {
    if (!this.bot || this.flushing) return;
    this.flushing = true;
    try {
      const rows = await this.prisma.telegramNotification.findMany({
        where: {
          sentAt: null,
          attempts: { lt: MAX_ATTEMPTS },
          // Упавшие ретраим не чаще раза в минуту
          OR: [
            { attempts: 0 },
            { updatedAt: { lt: new Date(Date.now() - RETRY_DELAY_MS) } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      for (const row of rows) await this.deliver(this.bot, row);
    } catch (e) {
      this.logger.error('Telegram outbox flush failed', e);
    } finally {
      this.flushing = false;
    }
  }

  private async deliver(bot: Bot, row: TelegramNotification) {
    const options = {
      parse_mode: 'HTML' as const,
      link_preview_options: { is_disabled: true },
      reply_markup: (row.replyMarkup ?? undefined) as
        | InlineKeyboard
        | undefined,
    };
    try {
      if (row.type === NotificationType.MATERIAL_ADDED && row.entityId) {
        const material = await this.prisma.material.findUniqueOrThrow({
          where: { id: row.entityId },
          select: { title: true, fileData: true },
        });
        if (row.telegramMessageId) {
          await bot.api.editMessageCaption(row.chatId, row.telegramMessageId, {
            caption: row.text,
            parse_mode: 'HTML',
          });
        } else {
          const sent = await bot.api.sendDocument(
            row.chatId,
            new InputFile(material.fileData, material.title),
            { caption: row.text, parse_mode: 'HTML' },
          );
          await this.prisma.telegramNotification.update({
            where: { id: row.id },
            data: { telegramMessageId: sent.message_id },
          });
        }
      } else if (row.telegramMessageId) {
        await bot.api.editMessageText(
          row.chatId,
          row.telegramMessageId,
          row.text,
          options,
        );
      } else {
        const sent = await bot.api.sendMessage(row.chatId, row.text, options);
        await this.prisma.telegramNotification.update({
          where: { id: row.id },
          data: { telegramMessageId: sent.message_id },
        });
      }
      await this.markEntitySent(row);
      await this.markSent(row);
    } catch (e) {
      if (
        e instanceof GrammyError &&
        e.description.includes('message is not modified')
      ) {
        await this.markEntitySent(row);
        await this.markSent(row);
        return;
      }
      const blocked = e instanceof GrammyError && e.error_code === 403;
      if (blocked) await this.deactivateChat(row.chatId);
      await this.prisma.telegramNotification.update({
        where: { id: row.id },
        data: {
          attempts: blocked ? MAX_ATTEMPTS : { increment: 1 },
          error: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  /** Помечает сообщение отправленным (с защитой от перезаписи измененного текста). */
  private markSent(row: TelegramNotification) {
    return this.prisma.telegramNotification.updateMany({
      where: { id: row.id, text: row.text },
      data: { sentAt: new Date(), error: null },
    });
  }

  private async markEntitySent({ type, entityId }: TelegramNotification) {
    if (!entityId) return;
    if (type === NotificationType.LESSON_REPORT) {
      await this.prisma.lessonReport.updateMany({
        where: { id: entityId },
        data: { sentToTelegram: true },
      });
    }
    if (type === NotificationType.RESCHEDULE_REQUEST) {
      await this.prisma.rescheduleRequest.updateMany({
        where: { id: entityId },
        data: { sentToTelegram: true },
      });
    }
    if (type === NotificationType.MATERIAL_ADDED) {
      await this.prisma.material.updateMany({
        where: { id: entityId },
        data: { sentToTelegram: true },
      });
    }
  }
}
