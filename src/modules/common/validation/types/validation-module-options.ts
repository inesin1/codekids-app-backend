import { ValidationPipeOptions } from '@nestjs/common';

export type ValidationModuleOptions = Omit<
  ValidationPipeOptions,
  'exceptionFactory'
>;
