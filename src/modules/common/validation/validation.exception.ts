import { BadRequestException, ValidationError } from '@nestjs/common';

const mapErrors = (errors: ValidationError[]): string[] => {
  return errors.flatMap((error) => {
    const constraints = error.constraints
      ? Object.values(error.constraints)
      : [];

    const childrenErrors = error.children?.length
      ? mapErrors(error.children).map(
          (childError) => `${error.property}.${childError}`,
        )
      : [];

    return [...constraints, ...childrenErrors];
  });
};

export class ValidationException extends BadRequestException {
  constructor(errors: ValidationError[]) {
    super(mapErrors(errors));
  }
}
