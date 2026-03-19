import { DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ValidationException } from './validation.exception';
import { ValidationModuleOptions } from './types/validation-module-options';

@Module({})
export class ValidationModule {
  static forRoot(options: ValidationModuleOptions = {}): DynamicModule {
    return {
      module: ValidationModule,
      providers: [
        {
          provide: APP_PIPE,
          useFactory: () =>
            new ValidationPipe({
              ...options,
              exceptionFactory: (errors) => new ValidationException(errors),
            }),
        },
      ],
    };
  }
}
