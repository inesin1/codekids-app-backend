import { BadRequestException } from '@nestjs/common';
import { Transform } from 'class-transformer';

/** Приводит query-строку к boolean ("true" -> true, "false" -> false). */
export const ToBoolean = () =>
  Transform(({ obj, key }) => {
    const rawValue = (obj as Record<string, unknown>)[key];
    if (rawValue === true || rawValue === 'true') return true;
    if (rawValue === false || rawValue === 'false') return false;
    if (rawValue === undefined || rawValue === null) return undefined;
    throw new BadRequestException('Boolean query values must be true or false');
  });
