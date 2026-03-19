export type ValidationExceptionResponse = {
  requestId: string;
  status: number;
  name: string;
  path: string;
  message: string;
  validationErrors: string[];
};
