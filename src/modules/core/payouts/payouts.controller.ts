import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PayoutsService } from './payouts.service';
import { CalculatePayoutDto } from './dto/calculate-payout.dto';
import { CalculateAllPayoutsDto } from './dto/calculate-all-payouts.dto';
import { FindPayoutsDto } from './dto/find-payouts.dto';

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

  @Roles(Role.ADMIN, Role.MANAGER, Role.TEACHER)
  @Get()
  async findAll(@Req() req: Express.Request, @Query() query: FindPayoutsDto) {
    const scope = await this.resolveScope(req.user!);
    return this.payoutsService.findAll(query, scope);
  }

  @Roles(Role.ADMIN)
  @Patch(':id/pay')
  markPaid(@Param('id') id: string) {
    return this.payoutsService.markPaid(id);
  }

  private async resolveScope(user: { id: string; roles: Role[] }) {
    if (user.roles.includes(Role.ADMIN) || user.roles.includes(Role.MANAGER)) {
      return undefined;
    }
    if (user.roles.includes(Role.TEACHER)) {
      const profile = await this.prisma.teacherProfile.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (!profile) throw new ForbiddenException('Teacher profile not found');
      return { teacherProfileId: profile.id };
    }
    throw new ForbiddenException();
  }
}
