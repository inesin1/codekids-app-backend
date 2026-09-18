import { ArrayNotEmpty, IsIn } from 'class-validator';
import { Role } from '../../../../generated/client';
import { CreateUserDto } from './create-user.dto';

/** DTO создания сотрудника (ADMIN/MANAGER, опционально TEACHER). */
export class CreateStaffDto extends CreateUserDto {
  @ArrayNotEmpty()
  @IsIn([Role.ADMIN, Role.MANAGER, Role.TEACHER], { each: true })
  roles: Role[];
}
