import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TransactionType } from '../../../generated/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatePaymentDto } from './dto/create-payment.dto';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Records a student top-up and its balance ledger entry atomically. */
  async create(studentId: string, dto: CreatePaymentDto) {
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(dto.amount);
    } catch {
      throw new BadRequestException('amount must be a valid decimal');
    }
    if (
      !amount.isFinite() ||
      amount.lte(0) ||
      amount.decimalPlaces() > 2 ||
      amount.greaterThan('9999999999.99')
    ) {
      throw new BadRequestException(
        'amount must be positive and have at most 2 decimal places',
      );
    }

    const description = dto.description?.trim() || null;
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ userId: string }>>(
        Prisma.sql`SELECT "userId" FROM "student_profiles" WHERE "userId" = ${studentId} FOR UPDATE`,
      );
      if (!locked.length) throw new NotFoundException('Student not found');

      const student = await tx.studentProfile.findUniqueOrThrow({
        where: { userId: studentId },
        select: { balance: true },
      });
      const balanceBefore = student.balance;
      const balanceAfter = balanceBefore.add(amount);
      if (balanceAfter.greaterThan('9999999999.99')) {
        throw new BadRequestException(
          'resulting balance exceeds the supported range',
        );
      }

      const payment = await tx.payment.create({
        data: { studentId, amount, description },
      });
      await tx.studentProfile.update({
        where: { userId: studentId },
        data: { balance: balanceAfter },
      });
      await tx.transaction.create({
        data: {
          studentId,
          type: TransactionType.MANUAL_TOPUP,
          amount,
          balanceBefore,
          balanceAfter,
          description,
        },
      });
      await this.audit.record(
        {
          action: 'payment.created',
          entityType: 'Payment',
          entityId: payment.id,
          details: {
            studentId,
            amount: amount.toString(),
            balanceAfter: balanceAfter.toString(),
          },
        },
        tx,
      );

      return payment;
    });
  }
}
