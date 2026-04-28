import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { PayoutStatus, Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PayoutsService } from './payouts.service';
import { CalculatePayoutDto } from './dto/calculate-payout.dto';
import { CalculateAllPayoutsDto } from './dto/calculate-all-payouts.dto';

@Controller('payouts')
export class PayoutsController {
  constructor(
    private readonly payoutsService: PayoutsService,
    private readonly prisma: PrismaService,
  ) {}

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('calculate')
  calculate(@Body() dto: CalculatePayoutDto) {
    return this.payoutsService.calculate(dto);
  }

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post('calculate-all')
  calculateAll(@Body() dto: CalculateAllPayoutsDto) {
    return this.payoutsService.calculateAll(dto);
  }

  @Get()
  async findAll(
    @Req() req: Express.Request,
    @Query('teacherId') teacherId?: string,
    @Query('status') status?: PayoutStatus,
    @Query('periodStart') periodStart?: string,
    @Query('periodEnd') periodEnd?: string,
  ) {
    const scope = await this.resolveScope(req.user!);
    return this.payoutsService.findAll(
      { teacherId, status, periodStart, periodEnd },
      scope,
    );
  }

  @Roles(Role.ADMIN)
  @Patch(':id/pay')
  markPaid(@Param('id') id: string) {
    return this.payoutsService.markPaid(id);
  }

  private async resolveScope(user: { id: string; role: string }) {
    if (user.role === Role.ADMIN || user.role === Role.MANAGER) {
      return undefined;
    }
    if (user.role === Role.TEACHER) {
      const profile = await this.prisma.teacherProfile.findUniqueOrThrow({
        where: { userId: user.id },
      });
      return { teacherProfileId: profile.id };
    }
    return undefined;
  }
}
