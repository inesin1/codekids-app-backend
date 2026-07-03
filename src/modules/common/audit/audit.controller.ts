import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '../../../generated/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuditService } from './audit.service';
import { FindAuditLogsDto } from './dto/find-audit-logs.dto';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Roles(Role.ADMIN, Role.MANAGER)
  @Get()
  findAll(@Query() query: FindAuditLogsDto) {
    return this.auditService.findAll(query);
  }
}
