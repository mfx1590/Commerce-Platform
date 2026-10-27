// The ClickHouse ALIAS-SHADOW lint. In ClickHouse an output alias replaces the column of the same name everywhere in
// its own SELECT, so `SELECT toString(event_id) AS event_id … WHERE event_id IN {ids:Array(UUID)}` compares a String
// to UUIDs and matches nothing. That class bit three times in Phase 5 (mart_cash_daily's fee_minor, reconcile's
// out_* rename, the erasure re-read that turned into a DELETE of real orders).
//
// Rule, per SELECT (each nesting level on its own): an item `<expr> AS <name>` whose expression is NOT just a plain
// reference to the column `<name>` (`name` or `t.name`) is a problem when `<name>` is then used, as a bare
// identifier, in that SELECT's WHERE / PREWHERE / ON, or inside another item of its own select list. GROUP BY /
// ORDER BY / HAVING by the alias stay allowed: there the alias is what is meant. A heuristic, deliberately strict on
// the shapes that hurt us; a false positive is fixed by renaming the alias (out_*, m_*), never by a suppression.

/** Comments and string literals out, so their text can never look like an identifier. */
function strip(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
}

/** Depth of every character (0 = outside any parenthesis). */
function depths(s: string): number[] {
  const d: number[] = [];
  let level = 0;
  for (const ch of s) {
    if (ch === ')') level -= 1;
    d.push(level);
    if (ch === '(') level += 1;
  }
  return d;
}

/** Splits `s` at the commas that sit at `level` (relative depths). */
function splitTop(s: string, dep: number[], from: number, level: number): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ',' && dep[from + i] === level) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

const usedAsBareIdentifier = (text: string, name: string): boolean =>
  new RegExp(`(?<![.\\w])${name}(?![\\w(])`, 'i').test(
    text.replace(new RegExp(`\\bAS\\s+${name}\\b`, 'gi'), ' '),
  );

/** Problems of one SQL text: `alias: where` for each shadowing alias. */
export function aliasShadows(rawSql: string): string[] {
  const sql = strip(rawSql);
  const dep = depths(sql);
  const problems: string[] = [];
  const selectRe = /\bSELECT\b/gi;
  for (let m = selectRe.exec(sql); m; m = selectRe.exec(sql)) {
    const start = m.index;
    const level = dep[start]!;
    // the end of this SELECT's level: the closing parenthesis of its group, or the end of the text
    let end = sql.length;
    for (let i = start; i < sql.length; i++)
      if (dep[i]! < level || (sql[i] === ';' && dep[i] === level)) {
        end = i;
        break;
      }
    // the FROM of THIS select (same level)
    const fromRe = /\bFROM\b/gi;
    fromRe.lastIndex = start + 6;
    let fromAt = -1;
    for (let f = fromRe.exec(sql); f && f.index < end; f = fromRe.exec(sql))
      if (dep[f.index] === level) {
        fromAt = f.index;
        break;
      }
    if (fromAt === -1) continue;
    const list = sql.slice(start + 6, fromAt);
    const items = splitTop(list, dep, start + 6, level);
    const rest = sql.slice(fromAt, end);
    // WHERE / PREWHERE / ON text of this level (up to the next clause keyword at this level)
    const filters: string[] = [];
    const clauseRe = /\b(WHERE|PREWHERE|ON)\b/gi;
    for (let c = clauseRe.exec(rest); c; c = clauseRe.exec(rest)) {
      if (dep[fromAt + c.index] !== level) continue;
      const after = rest.slice(c.index + c[0].length);
      const stop = after.search(
        /\b(GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|SETTINGS|FORMAT|UNION|WHERE|LEFT|INNER|RIGHT|FULL|CROSS|JOIN|ARRAY\s+JOIN)\b/i,
      );
      filters.push(stop === -1 ? after : after.slice(0, stop));
    }
    items.forEach((item, idx) => {
      const am = /^([\s\S]*\S)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(item.trim());
      if (!am) return;
      const expr = am[1]!.trim();
      const name = am[2]!;
      if (new RegExp(`^(\\w+\\.)?${name}$`, 'i').test(expr)) return; // a plain reference to the same column
      if (filters.some((f) => usedAsBareIdentifier(f, name)))
        problems.push(
          `${name}: the alias of an expression shadows the column in this SELECT's WHERE/ON`,
        );
      else if (items.some((other, j) => j !== idx && usedAsBareIdentifier(other, name)))
        problems.push(
          `${name}: the alias of an expression shadows the column inside another select item`,
        );
    });
  }
  return problems;
}

/** The SQL inside TypeScript template literals (interpolations become a neutral placeholder). */
export function sqlInTypeScript(source: string): string[] {
  const out: string[] = [];
  const re = /`((?:[^`\\]|\\.)*)`/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const text = m[1]!.replace(/\$\{[^}]*\}/g, 'x_param');
    if (/\bSELECT\b/i.test(text) && /\bFROM\b/i.test(text)) out.push(text);
  }
  return out;
}
