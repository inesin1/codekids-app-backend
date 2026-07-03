import { Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { CLS_REQ, ClsService } from 'nestjs-cls';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { FindAuditLogsDto } from './dto/find-audit-logs.dto';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  // Актор берётся из CLS-контекста запроса; вне HTTP (cron) — система (userId = null).
  // Fire-and-forget: ошибка записи аудита не должна ронять бизнес-операцию.
  log(entry: {
    action: string;
    entityType: string;
    entityId?: string;
    details?: object;
  }): void {
    const req = this.cls.isActive()
      ? this.cls.get<Request | undefined>(CLS_REQ)
      : undefined;

    // JSON-клон отбрасывает undefined-поля (DTO с необязательными полями)
    const details =
      entry.details == null
        ? undefined
        : (JSON.parse(JSON.stringify(entry.details)) as Prisma.InputJsonValue);

    void this.prisma.auditLog
      .create({
        data: {
          ...entry,
          details,
          userId: req?.user?.id ?? null,
          ipAddress: req?.ip,
          userAgent: req?.headers['user-agent'],
        },
      })
      .catch((e) =>
        this.logger.error(`Failed to write audit log ${entry.action}`, e),
      );
  }

  findAll(query: FindAuditLogsDto) {
    return this.prisma.auditLog.findMany({
      where: {
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
      },
      include: { user: { omit: { password: true } } },
      orderBy: { createdAt: 'desc' },
      take: query.take,
      skip: query.skip,
    });
  }
}
