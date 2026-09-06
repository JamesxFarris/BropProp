import { config } from './config.js';
import { migrate } from './migrate.js';

/**
 * One entrypoint, two roles.
 *
 * Railway applies a single start command across every service built from this
 * repo, so the logger and the dashboard are distinguished by SERVICE_ROLE
 * rather than by per-service command overrides that are easy to set once and
 * then forget when a service is recreated.
 *
 * Only the worker migrates. If both roles migrated, a simultaneous deploy would
 * race on the ledger insert and crash whichever service lost.
 */
const role = (process.env.SERVICE_ROLE ?? 'worker').toLowerCase();

if (role === 'web' || role === 'dashboard') {
  console.log('role: web — starting dashboard');
  await import('./web/server.js');
} else {
  console.log('role: worker — migrating, then scheduling polls');
  await migrate();
  console.log(`leagues: ${config.leagues.join(',')}`);
  await import('./cron.js');
}
