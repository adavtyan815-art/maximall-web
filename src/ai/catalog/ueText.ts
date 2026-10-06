/**
 * Parser for Unreal's ExportText property format as produced by DataTable JSON export for nested structs, e.g.
 *   (Sizes=("/Game/a.a","/Game/b.b"),SizeNames=(NSLOCTEXT("[ns]", "key", "80")),Colors=((SKU="#FFF",SizeIndices=(0))))
 * Result: objects for `(k=v,...)`, arrays for `(v,v,...)`, strings for "…" and NSLOCTEXT/INVTEXT/LOCTEXT (the source
 * text), numbers, booleans, and bare identifiers (enum values, None) as strings.
 */
export function parseUeText(input: string): any {
  let i = 0;
  const s = input;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const str = (): string => {
    // s[i] === '"'
    i++;
    let out = '';
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\' && i + 1 < s.length) {
        const n = s[i + 1];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
        i += 2;
        continue;
      }
      out += s[i++];
    }
    i++; // closing quote
    return out;
  };
  const ident = (): string => {
    const st = i;
    while (i < s.length && /[A-Za-z0-9_.:\-+/\\]/.test(s[i])) i++;
    return s.slice(st, i);
  };
  const value = (): any => {
    ws();
    const c = s[i];
    if (c === '"') return str();
    if (c === '(') return group();
    const id = ident();
    ws();
    if (s[i] === '(' && /^(NSLOCTEXT|LOCTEXT|INVTEXT|LOCTABLE)$/.test(id)) {
      i++;
      const args: string[] = [];
      while (i < s.length) {
        ws();
        if (s[i] === ')') {
          i++;
          break;
        }
        if (s[i] === ',') {
          i++;
          continue;
        }
        if (s[i] === '"') args.push(str());
        else ident();
      }
      return args[args.length - 1] ?? '';
    }
    if (id === 'True' || id === 'true') return true;
    if (id === 'False' || id === 'false') return false;
    if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(id)) return Number(id);
    return id;
  };
  const group = (): any => {
    // s[i] === '('
    i++;
    ws();
    if (s[i] === ')') {
      i++;
      return [];
    }
    // Look ahead: is this a struct (Key=...) or an array?
    const save = i;
    const maybeKey = ident();
    ws();
    const isStruct = maybeKey.length > 0 && s[i] === '=' && s[i + 1] !== '=';
    i = save;
    if (isStruct) {
      const obj: Record<string, any> = {};
      while (i < s.length) {
        ws();
        if (s[i] === ')') {
          i++;
          break;
        }
        if (s[i] === ',') {
          i++;
          continue;
        }
        const k = ident();
        ws();
        if (s[i] === '=') i++;
        obj[k] = value();
      }
      return obj;
    }
    const arr: any[] = [];
    while (i < s.length) {
      ws();
      if (s[i] === ')') {
        i++;
        break;
      }
      if (s[i] === ',') {
        i++;
        continue;
      }
      arr.push(value());
    }
    return arr;
  };
  ws();
  if (s[i] === '(') return group();
  return value();
}

/** Recursively parses string fields that look like UE struct/array text. */
export function deepParseUe(v: any): any {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('(') && t.endsWith(')')) {
      try {
        return parseUeText(t);
      } catch {
        return v;
      }
    }
    const m = t.match(/^(?:NSLOCTEXT|INVTEXT|LOCTEXT)\(/);
    if (m) {
      try {
        return parseUeText(t);
      } catch {
        return v;
      }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(deepParseUe);
  if (v && typeof v === 'object') {
    const o: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) o[k] = deepParseUe(x);
    return o;
  }
  return v;
}
