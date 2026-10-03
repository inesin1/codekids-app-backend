import { registerDecorator, ValidationOptions } from 'class-validator';

export function IsDateRangeOrdered(
  startProperty: string,
  options?: ValidationOptions,
) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'isDateRangeOrdered',
      target: target.constructor,
      propertyName,
      constraints: [startProperty],
      options,
      validator: {
        validate(end: unknown, args) {
          if (!args) return true;
          const [startProperty] = args.constraints as [string];
          const start = (args.object as Record<string, unknown>)[startProperty];
          if (typeof start !== 'string' || typeof end !== 'string') return true;
          const startTime = Date.parse(start);
          const endTime = Date.parse(end);
          return (
            Number.isFinite(startTime) &&
            Number.isFinite(endTime) &&
            endTime >= startTime
          );
        },
      },
    });
}
