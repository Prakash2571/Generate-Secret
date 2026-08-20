import { config } from '../../src/config';

/**
 * Shared test setup: keeps the runner output readable.
 *
 * The logger reads `config.logLevel` on every call, so lowering it here
 * silences informational lines. Report output uses `logger.raw`, which ignores
 * the level, so assertions on printed reports still work.
 */
config.logLevel = 'error';

export {};
