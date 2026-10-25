import type { CSSProperties } from 'react';

/** How a run of terminal output looks, from the SGR escape codes before it. */
export type IAnsiStyle = {
  /** A CSS color, or null for the line's own color. */
  color: string | null;
  background: string | null;
  isBold: boolean;
  isDim: boolean;
  isItalic: boolean;
  isUnderline: boolean;
  isStrikethrough: boolean;
};

/** A styled stretch of the visible text, by character offsets. */
export type IAnsiRun = {
  start: number;
  end: number;
  style: IAnsiStyle;
};

/** A line without its escape codes, and the styled runs of what is left. */
export type IAnsiText = {
  text: string;
  runs: IAnsiRun[];
};

const DEFAULT_STYLE: IAnsiStyle = Object.freeze({
  color: null,
  background: null,
  isBold: false,
  isDim: false,
  isItalic: false,
  isUnderline: false,
  isStrikethrough: false,
});

/** The 16 basic colors, in code order; each names a `--color-ansi-*` token. */
const COLOR_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

// Escape sequences: CSI (colors, cursor moves, erasing), OSC (titles, links)
// up to BEL or ST, a character set choice such as the "ESC ( B" that
// `tput sgr0` prints, other two-character ones, and a lone ESC.
const ESCAPE_PATTERN =
  /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()*+].|[@-Z\\-_])?/g;

function basicColor(index: number) {
  const name = COLOR_NAMES[index % 8];
  return `var(--color-ansi-${index < 8 ? name : `bright-${name}`})`;
}

/** A color of the 256-color palette: the basic 16, a 6×6×6 cube, then 24 grays. */
function paletteColor(index: number) {
  if (index < 16) {
    return basicColor(index);
  }
  if (index < 232) {
    const cube = index - 16;
    const [red, green, blue] = [Math.floor(cube / 36), Math.floor(cube / 6) % 6, cube % 6];
    return `rgb(${CUBE_LEVELS[red]} ${CUBE_LEVELS[green]} ${CUBE_LEVELS[blue]})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray} ${gray} ${gray})`;
}

const isByte = (value: number | undefined) =>
  value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255;

/**
 * Reads the color after 38 or 48: "5;n" from the 256-color palette, or
 * "2;r;g;b". Returns how many codes it used; a malformed one uses the rest.
 */
function extendedColor(codes: number[], index: number): [string | null, number] {
  const mode = codes[index];
  if (mode === 5 && isByte(codes[index + 1])) {
    return [paletteColor(codes[index + 1]), 2];
  }
  const [red, green, blue] = codes.slice(index + 1, index + 4);
  if (mode === 2 && isByte(red) && isByte(green) && isByte(blue)) {
    return [`rgb(${red} ${green} ${blue})`, 4];
  }
  return [null, codes.length];
}

/** Applies the codes of one SGR sequence. Codes it does not know are skipped. */
function applySgr(current: IAnsiStyle, params: string): IAnsiStyle {
  // An empty code means 0, so "ESC[m" resets too.
  const codes = params.split(';').map(Number);
  const next = { ...current };
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code === 0) {
      Object.assign(next, DEFAULT_STYLE);
    } else if (code === 1) {
      next.isBold = true;
    } else if (code === 2) {
      next.isDim = true;
    } else if (code === 3) {
      next.isItalic = true;
    } else if (code === 4) {
      next.isUnderline = true;
    } else if (code === 9) {
      next.isStrikethrough = true;
    } else if (code === 22) {
      next.isBold = false;
      next.isDim = false;
    } else if (code === 23) {
      next.isItalic = false;
    } else if (code === 24) {
      next.isUnderline = false;
    } else if (code === 29) {
      next.isStrikethrough = false;
    } else if (code >= 30 && code <= 37) {
      next.color = basicColor(code - 30);
    } else if (code >= 90 && code <= 97) {
      next.color = basicColor(code - 90 + 8);
    } else if (code === 39) {
      next.color = null;
    } else if (code >= 40 && code <= 47) {
      next.background = basicColor(code - 40);
    } else if (code >= 100 && code <= 107) {
      next.background = basicColor(code - 100 + 8);
    } else if (code === 49) {
      next.background = null;
    } else if (code === 38 || code === 48) {
      const [color, used] = extendedColor(codes, index + 1);
      index += used;
      next[code === 38 ? 'color' : 'background'] = color;
    }
  }
  const isDefault = (Object.keys(DEFAULT_STYLE) as (keyof IAnsiStyle)[]).every(
    key => next[key] === DEFAULT_STYLE[key]
  );
  return isDefault ? DEFAULT_STYLE : next;
}

/**
 * Takes the escape codes out of a line of terminal output, and keeps what the
 * color codes asked for as styled runs. Every line starts unstyled.
 */
export function parseAnsi(raw: string): IAnsiText {
  if (!raw.includes('\x1b')) {
    return { text: raw, runs: [] };
  }
  let text = '';
  const runs: IAnsiRun[] = [];
  let style = DEFAULT_STYLE;
  const append = (piece: string) => {
    if (piece && style !== DEFAULT_STYLE) {
      const last = runs.at(-1);
      if (last && last.style === style && last.end === text.length) {
        last.end += piece.length;
      } else {
        runs.push({ start: text.length, end: text.length + piece.length, style });
      }
    }
    text += piece;
  };

  let cursor = 0;
  for (const match of raw.matchAll(ESCAPE_PATTERN)) {
    append(raw.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const [, params, final] = match;
    if (final === 'm' && /^[\d;]*$/.test(params)) {
      style = applySgr(style, params);
    }
  }
  append(raw.slice(cursor));
  return { text, runs };
}

/** The CSS for a run. Dim fades only the run's color, so a search mark in it stays bright. */
export function getAnsiStyle(style: IAnsiStyle): CSSProperties {
  const color = style.color ?? 'currentColor';
  const decorations = [style.isUnderline && 'underline', style.isStrikethrough && 'line-through'];
  return {
    color: style.isDim
      ? `color-mix(in srgb, ${color} 60%, transparent)`
      : (style.color ?? undefined),
    backgroundColor: style.background ?? undefined,
    fontWeight: style.isBold ? 600 : undefined,
    fontStyle: style.isItalic ? 'italic' : undefined,
    // No italic face is loaded, and the page turns synthesis off.
    fontSynthesis: style.isItalic ? 'style' : undefined,
    textDecorationLine: decorations.filter(Boolean).join(' ') || undefined,
  };
}
