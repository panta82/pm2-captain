import { describe, expect, it } from 'vitest';

import { getAnsiStyle, parseAnsi } from '../../../../src/frontend/lib/ansi';

const ESC = '\x1b';

/** Each run's text and the parts of its style that are set. */
function runsOf(raw: string) {
  const { text, runs } = parseAnsi(raw);
  return runs.map(run => ({
    text: text.slice(run.start, run.end),
    ...Object.fromEntries(Object.entries(run.style).filter(([, value]) => value)),
  }));
}

describe('parseAnsi', () => {
  it('leaves text without escape codes alone', () => {
    expect(parseAnsi('plain line')).toEqual({ text: 'plain line', runs: [] });
  });

  it('takes out the codes webpack prints, and keeps their styles', () => {
    const raw = `modules by path ${ESC}[1m./src/extension/${ESC}[39m${ESC}[22m 116 KiB ${ESC}[1m${ESC}[33m[built]${ESC}[39m${ESC}[22m`;

    expect(parseAnsi(raw).text).toBe('modules by path ./src/extension/ 116 KiB [built]');
    expect(runsOf(raw)).toEqual([
      { text: './src/extension/', isBold: true },
      { text: '[built]', isBold: true, color: 'var(--color-ansi-yellow)' },
    ]);
  });

  it('reads basic, bright, 256 and true colors, for text and background', () => {
    expect(
      runsOf(
        `${ESC}[31ma${ESC}[92mb${ESC}[38;5;196mc${ESC}[38;5;244md${ESC}[38;2;1;2;3;44me${ESC}[0mf`
      )
    ).toEqual([
      { text: 'a', color: 'var(--color-ansi-red)' },
      { text: 'b', color: 'var(--color-ansi-bright-green)' },
      { text: 'c', color: 'rgb(255 0 0)' },
      { text: 'd', color: 'rgb(128 128 128)' },
      { text: 'e', color: 'rgb(1 2 3)', background: 'var(--color-ansi-blue)' },
    ]);
  });

  it('turns each attribute off with its own code, and everything off with a reset', () => {
    expect(
      runsOf(`${ESC}[1;2;3;4;9ma${ESC}[22mb${ESC}[23;24mc${ESC}[29md${ESC}[33me${ESC}[me`)
    ).toEqual([
      {
        text: 'a',
        isBold: true,
        isDim: true,
        isItalic: true,
        isUnderline: true,
        isStrikethrough: true,
      },
      { text: 'b', isItalic: true, isUnderline: true, isStrikethrough: true },
      { text: 'c', isStrikethrough: true },
      { text: 'e', color: 'var(--color-ansi-yellow)' },
    ]);
  });

  it('drops other escape sequences without changing the style', () => {
    const raw = `${ESC}[2K${ESC}[1G${ESC}[32m${ESC}]0;title${ESC}\\ok${ESC}(B${ESC}[m done ${ESC}`;

    expect(parseAnsi(raw).text).toBe('ok done ');
    expect(runsOf(raw)).toEqual([{ text: 'ok', color: 'var(--color-ansi-green)' }]);
  });

  it('skips a malformed extended color and the codes after it', () => {
    expect(runsOf(`${ESC}[38;5;300;1mx`)).toEqual([]);
    expect(runsOf(`${ESC}[38;2;1;2mx`)).toEqual([]);
  });
});

describe('getAnsiStyle', () => {
  it('dims by fading the color, so marks inside keep theirs', () => {
    const { runs } = parseAnsi(`${ESC}[2;31mx${ESC}[22;39;2my`);

    expect(getAnsiStyle(runs[0].style).color).toBe(
      'color-mix(in srgb, var(--color-ansi-red) 60%, transparent)'
    );
    expect(getAnsiStyle(runs[1].style)).toMatchObject({
      color: 'color-mix(in srgb, currentColor 60%, transparent)',
    });
  });
});
