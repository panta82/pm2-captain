import { describe, expect, it } from 'vitest';

import { createLoggerOptions } from '../../../../src/backend/lib/logger';

describe('logger options', () => {
  it('only emits errors by default', () => {
    expect(createLoggerOptions().level).toBe('error');
  });

  it('enables diagnostic logs and formatting in debug mode', () => {
    const options = createLoggerOptions(true);

    expect(options.level).toBe('debug');
    expect(options.transport).toBeTruthy();
  });
});
