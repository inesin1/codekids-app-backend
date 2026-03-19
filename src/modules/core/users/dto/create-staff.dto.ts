import { IsIn } from 'class-validator';
import { Role } from '../../../../generated/client';
import { CreateUserDto } from './create-user.dto';

export class CreateStaffDto extends CreateUserDto {
  @IsIn([Role.ADMIN, Role.MANAGER])
  role: typeof Role.ADMIN | typeof Role.MANAGER;
}
