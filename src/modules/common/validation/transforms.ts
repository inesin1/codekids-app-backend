import { Transform } from 'class-transformer';

// Приводит query-строку к boolean: "true"→true, "false"→false, иначе undefined.
// enableImplicitConversion этого не делает (любая непустая строка → true).
export const ToBoolean = () =>
  Transform(({ value }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return undefined;
  });
