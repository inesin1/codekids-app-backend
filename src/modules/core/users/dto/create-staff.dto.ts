import { ArrayNotEmpty, IsIn } from 'class-validator';
import { Role } from '../../../../generated/client';
import { CreateUserDto } from './create-user.dto';

// staff = ADMIN/MANAGER, опционально + TEACHER (управленец, который ещё и ведёт)
export class CreateStaffDto extends CreateUserDto {
  @ArrayNotEmpty()
  @IsIn([Role.ADMIN, Role.MANAGER, Role.TEACHER], { each: true })
  roles: Role[];
}
