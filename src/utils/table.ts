export type Align = 'left' | 'right';

export interface TableSpec {
  head: string[];
  rows: string[][];
  align?: Align[];
  /** Optional per-column hard cap; longer cells are ellipsised. */
  maxWidths?: number[];
}

function truncate(value: string, max: number | undefined): string {
  if (!max || value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}\u2026`;
}

function pad(value: string, width: number, align: Align): string {
  const gap = Math.max(0, width - value.length);
  return align === 'right' ? `${' '.repeat(gap)}${value}` : `${value}${' '.repeat(gap)}`;
}

/**
 * Renders a box-drawing table without pulling in a dependency.
 * Keeps the CLI output stable and dependency-free.
 */
export function renderTable(spec: TableSpec): string {
  const columns = spec.head.length;
  const align: Align[] = Array.from(
    { length: columns },
    (_unused, index) => spec.align?.[index] ?? 'left',
  );

  const head = spec.head.map((cell, index) => truncate(cell, spec.maxWidths?.[index]));
  const rows = spec.rows.map((row) =>
    Array.from({ length: columns }, (_unused, index) =>
      truncate(row[index] ?? '', spec.maxWidths?.[index]),
    ),
  );

  const widths = Array.from({ length: columns }, (_unused, index) => {
    const cells = [head[index] ?? '', ...rows.map((row) => row[index] ?? '')];
    return cells.reduce((max, cell) => Math.max(max, cell.length), 0);
  });

  const line = (left: string, mid: string, right: string): string =>
    `${left}${widths.map((width) => '\u2500'.repeat(width + 2)).join(mid)}${right}`;

  const renderRow = (cells: string[]): string =>
    `\u2502 ${cells
      .map((cell, index) => pad(cell, widths[index] ?? 0, align[index] ?? 'left'))
      .join(' \u2502 ')} \u2502`;

  const out: string[] = [];
  out.push(line('\u250c', '\u252c', '\u2510'));
  out.push(renderRow(head));
  out.push(line('\u251c', '\u253c', '\u2524'));
  if (rows.length === 0) {
    const inner = widths.reduce((sum, width) => sum + width + 3, 0) - 1;
    out.push(`\u2502${pad(' (none)', inner, 'left')}\u2502`);
  } else {
    for (const row of rows) out.push(renderRow(row));
  }
  out.push(line('\u2514', '\u2534', '\u2518'));
  return out.join('\n');
}

export function divider(width = 52): string {
  return '='.repeat(width);
}
