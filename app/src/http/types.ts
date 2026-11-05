import type { Hono } from 'hono';
import type { Session } from '../auth';

export type ApiEnvironment = {
  Variables: { session: Session | null; personIsAdmin?: boolean };
};

export type ApiApplication = Hono<ApiEnvironment>;
