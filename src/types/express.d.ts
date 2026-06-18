import { Role } from '../generated/client';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        roles: Role[];
      };
    }
  }
}
