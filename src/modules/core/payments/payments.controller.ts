import { Body, Controller, Param, Post } from '@nestjs/common';
import { Role } from '../../../generated/client';
import { Roles } from '../../common/auth/decorators/roles.decorator';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentsService } from './payments.service';

@Controller('users/:studentId/payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Roles(Role.ADMIN, Role.MANAGER)
  @Post()
  create(@Param('studentId') studentId: string, @Body() dto: CreatePaymentDto) {
    return this.paymentsService.create(studentId, dto);
  }
}
