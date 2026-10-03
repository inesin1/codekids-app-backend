import { Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { CLS_REQ, ClsService } from 'nestjs-cls';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { FindAuditLogsDto } from './dto/find-audit-logs.dto';
import { paginated, paginationArgs } from '../pagination';

type AuditEntry = {
  action: string;
  entityType: string;
  entityId?: string;
  details?: object;
  actorId?: string;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  /** Сохраняет обязательное событие аудита в переданной транзакции. */
  async record(
    { actorId, ...entry }: AuditEntry,
    db: Prisma.TransactionClient,
  ): Promise<void> {
    const req = this.cls.isActive()
      ? this.cls.get<Request | undefined>(CLS_REQ)
      : undefined;

    // JSON-сериализация отбрасывает undefined-поля
    const details =
      entry.details == null
        ? undefined
        : (JSON.parse(JSON.stringify(entry.details)) as Prisma.InputJsonValue);

    await db.auditLog.create({
      data: {
        ...entry,
        details,
        userId: actorId ?? req?.user?.id ?? null,
        ipAddress: req?.ip,
        userAgent: req?.headers['user-agent'],
      },
    });
  }

  /** Записывает необязательное событие аудита без ожидания результата. */
  log(entry: AuditEntry): void {
    void this.record(entry, this.prisma).catch((e) =>
      this.logger.error(`Failed to write audit log ${entry.action}`, e),
    );
  }

  /** Возвращает записи журнала аудита по заданным фильтрам. */
  async findAll(query: FindAuditLogsDto) {
    const where = {
      userId: query.userId,
      action: query.action,
      entityType: query.entityType,
      entityId: query.entityId,
      ...((query.from || query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
    };
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: { user: { omit: { password: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...paginationArgs(query),
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginated(data, total, query, '/api/audit-logs', {
      userId: query.userId,
      action: query.action,
      entityType: query.entityType,
      entityId: query.entityId,
      from: query.from,
      to: query.to,
    });
  }
}
