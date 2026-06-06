#!/usr/bin/env bun
/**
 * audit-mssql-isms.ts — escanea un codebase buscando construcciones específicas
 * de SQL Server que deben reescribirse para Postgres.
 *
 * Uso:
 *   bun audit-mssql-isms.ts <ruta-al-backend>
 *   bun audit-mssql-isms.ts <ruta> --json > report.json
 *   bun audit-mssql-isms.ts <ruta> --severity high   # solo bloqueantes
 *
 * Exit codes:
 *   0 — limpio (o solo info-level)
 *   1 — encontró findings high/medium
 *   2 — error operacional (ruta inválida, etc.)
 *
 * Detecta:
 *   - SQL inline embebido en strings: TOP, ISNULL, GETDATE, [brackets], etc.
 *   - ORM dialects: TypeORM/Prisma/Sequelize/EF apuntando a mssql
 *   - Drivers: imports de `mssql`, `tedious`, `node-mssql`
 *   - Connection strings con `Server=...; Database=...`
 *   - SQL features sin equivalente directo: MERGE, OUTPUT, WITH (NOLOCK)
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

type Severity = 'high' | 'medium' | 'low' | 'info';

interface Pattern {
  id: string;
  severity: Severity;
  description: string;
  re: RegExp;
  fix: string;
}

const PATTERNS: Pattern[] = [
  // ─── ORM / driver level (high — codebase-wide refactor) ────────────────────
  {
    id: 'driver.mssql-import',
    severity: 'high',
    description: 'Import del driver mssql / tedious',
    re: /\b(?:import|require|from)\s*\(?['"`](mssql|tedious|node-mssql|mssql-stream)['"`]/g,
    fix: 'reemplazar por `postgres` (postgres-js) o `pg`',
  },
  {
    id: 'orm.typeorm-mssql',
    severity: 'high',
    description: 'TypeORM configurado con type: "mssql"',
    re: /type\s*:\s*['"`]mssql['"`]/g,
    fix: 'cambiar a type: "postgres"',
  },
  {
    id: 'orm.sequelize-mssql',
    severity: 'high',
    description: 'Sequelize con dialect: "mssql"',
    re: /dialect\s*:\s*['"`]mssql['"`]/g,
    fix: 'cambiar a dialect: "postgres" e instalar pg',
  },
  {
    id: 'orm.prisma-sqlserver',
    severity: 'high',
    description: 'Prisma con provider = "sqlserver"',
    re: /provider\s*=\s*['"`]sqlserver['"`]/g,
    fix: 'cambiar a provider = "postgresql" y regenerar el cliente',
  },
  {
    id: 'orm.ef-usesqlserver',
    severity: 'high',
    description: 'EF Core con UseSqlServer',
    re: /\.UseSqlServer\s*\(/g,
    fix: 'cambiar a .UseNpgsql() y agregar Npgsql.EntityFrameworkCore.PostgreSQL',
  },
  {
    id: 'connstr.mssql-style',
    severity: 'high',
    description: 'Connection string formato SQL Server (Server=...; Database=...;)',
    re: /["'`][^"'`]*Server\s*=\s*[^;"'`]+;\s*Database\s*=\s*[^;"'`]+/gi,
    fix: 'reemplazar por URI postgres://user:pass@host:5432/db',
  },

  // ─── SQL inline (medium — refactor por query, mecánico) ────────────────────
  {
    id: 'sql.bracket-identifiers',
    severity: 'medium',
    description: 'Identificadores con [brackets] (estilo SQL Server)',
    re: /\[[A-Za-z_][A-Za-z0-9_]*\](?=\s*[.,)\s])/g,
    fix: 'remover brackets o usar "double quotes" si necesita case-sensitive',
  },
  {
    id: 'sql.top-clause',
    severity: 'medium',
    description: 'SELECT TOP N — no soportado en Postgres',
    re: /\bSELECT\s+(?:DISTINCT\s+)?TOP\s*\(?\s*\d+/gi,
    fix: 'reemplazar por LIMIT N al final de la query',
  },
  {
    id: 'sql.isnull',
    severity: 'medium',
    description: 'ISNULL(x, y) — función SQL Server',
    re: /\bISNULL\s*\(/gi,
    fix: 'reemplazar por COALESCE(x, y) — sintaxis idéntica',
  },
  {
    id: 'sql.getdate',
    severity: 'medium',
    description: 'GETDATE() / SYSDATETIME() / SYSUTCDATETIME()',
    re: /\b(GETDATE|SYSDATETIME|SYSUTCDATETIME|GETUTCDATE)\s*\(\s*\)/gi,
    fix: 'GETDATE → now() o current_timestamp; GETUTCDATE → now() AT TIME ZONE \'UTC\'',
  },
  {
    id: 'sql.newid',
    severity: 'medium',
    description: 'NEWID() para uniqueidentifier',
    re: /\bNEWID\s*\(\s*\)/gi,
    fix: 'gen_random_uuid() (requiere extension pgcrypto)',
  },
  {
    id: 'sql.identity-fn',
    severity: 'medium',
    description: '@@IDENTITY / SCOPE_IDENTITY / IDENT_CURRENT',
    re: /(?:@@IDENTITY|\bSCOPE_IDENTITY\s*\(|\bIDENT_CURRENT\s*\()/gi,
    fix: 'reemplazar con cláusula RETURNING id en el INSERT',
  },
  {
    id: 'sql.dateadd',
    severity: 'medium',
    description: 'DATEADD / DATEDIFF',
    re: /\b(DATEADD|DATEDIFF|DATEPART)\s*\(/gi,
    fix: "operadores intervalo: x + interval '1 day'; date_part('year', x); EXTRACT",
  },
  {
    id: 'sql.iif',
    severity: 'medium',
    description: 'IIF(condición, a, b)',
    re: /\bIIF\s*\(/gi,
    fix: 'reemplazar por CASE WHEN cond THEN a ELSE b END',
  },
  {
    id: 'sql.charindex',
    severity: 'medium',
    description: 'CHARINDEX / PATINDEX',
    re: /\b(CHARINDEX|PATINDEX)\s*\(/gi,
    fix: 'CHARINDEX(needle, haystack) → position(needle in haystack) o strpos()',
  },
  {
    id: 'sql.len-fn',
    severity: 'medium',
    description: 'LEN() — Postgres usa length() / char_length()',
    re: /\bLEN\s*\(/g,
    fix: 'length(x) para chars; octet_length(x) para bytes',
  },
  {
    id: 'sql.convert-fn',
    severity: 'medium',
    description: 'CONVERT(tipo, valor[, estilo])',
    re: /\bCONVERT\s*\(\s*[A-Za-z]+\s*(?:\(\s*\d+\s*\))?\s*,/gi,
    fix: "CAST(valor AS tipo) o valor::tipo; estilos de fecha → to_char(x, 'fmt')",
  },
  {
    id: 'sql.merge-stmt',
    severity: 'medium',
    description: 'MERGE statement (UPSERT estilo SQL Server)',
    re: /\bMERGE\s+(?:INTO\s+)?[A-Za-z_]/gi,
    fix: 'INSERT ... ON CONFLICT (key) DO UPDATE SET ...',
  },
  {
    id: 'sql.output-clause',
    severity: 'medium',
    description: 'OUTPUT INSERTED.* / DELETED.*',
    re: /\bOUTPUT\s+(?:INSERTED|DELETED)\b/gi,
    fix: 'cláusula RETURNING (mismo patrón conceptual)',
  },
  {
    id: 'sql.with-nolock',
    severity: 'low',
    description: 'WITH (NOLOCK) hint',
    re: /WITH\s*\(\s*NOLOCK\s*\)/gi,
    fix: 'remover (Postgres usa MVCC, no requiere hint para reads sin lock)',
  },
  {
    id: 'sql.dbo-prefix',
    severity: 'low',
    description: 'Schema dbo.tabla',
    re: /\b\[?dbo\]?\.[A-Za-z_]/g,
    fix: 'remover dbo. o reemplazar por mlm./auth./public. según corresponda',
  },
  {
    id: 'sql.exec-sp',
    severity: 'medium',
    description: 'EXEC sp_executesql / stored procedures dinámicos',
    re: /\bEXEC(?:UTE)?\s+sp_executesql\b/gi,
    fix: 'queries parametrizadas del driver Postgres (no requieren wrapper)',
  },
  {
    id: 'sql.varchar-max',
    severity: 'low',
    description: 'varchar(max) / nvarchar(max)',
    re: /\b(?:n?varchar|nvarchar)\s*\(\s*max\s*\)/gi,
    fix: 'text en Postgres (sin límite explícito)',
  },
  {
    id: 'sql.bit-type',
    severity: 'low',
    description: 'Tipo bit (en DDL)',
    re: /\bbit\s+(?:NOT\s+NULL|NULL|DEFAULT)/gi,
    fix: 'boolean en Postgres',
  },
  {
    id: 'sql.uniqueidentifier',
    severity: 'low',
    description: 'Tipo uniqueidentifier (en DDL)',
    re: /\buniqueidentifier\b/gi,
    fix: 'uuid en Postgres',
  },
  {
    id: 'sql.string-concat-plus',
    severity: 'info',
    description: 'Concatenación con + en SQL (puede ser legítimo en TS/JS)',
    re: /['"`][^'"`]*\b(?:SELECT|UPDATE|INSERT|WHERE)\b[^'"`]*['"`]\s*\+\s*['"`]/gi,
    fix: 'verificar — Postgres usa || en SQL, pero + en strings de host language es OK',
  },
  {
    id: 'sql.go-batch-separator',
    severity: 'info',
    description: 'GO batch separator (T-SQL)',
    re: /^\s*GO\s*$/gim,
    fix: 'remover; Postgres usa ; entre statements',
  },
];

const APP_CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cs', '.py', '.java', '.php', '.go', '.rb', '.kt']);
const SQL_EXTS = new Set(['.sql']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'bin', 'obj', 'target', '.next', '.nuxt', 'vendor', '__pycache__', '.venv', 'venv', 'coverage']);
const SELF_FILE = 'audit-mssql-isms.ts';

interface Finding {
  file: string;
  line: number;
  column: number;
  patternId: string;
  severity: Severity;
  match: string;
  context: string;
  fix: string;
}

async function* walk(dir: string, includeSql: boolean): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      yield* walk(join(dir, entry.name), includeSql);
    } else if (entry.isFile() && entry.name !== SELF_FILE) {
      const ext = extname(entry.name);
      if (APP_CODE_EXTS.has(ext) || (includeSql && SQL_EXTS.has(ext))) {
        yield join(dir, entry.name);
      }
    }
  }
}

async function scanFile(path: string, root: string): Promise<Finding[]> {
  const content = await readFile(path, 'utf8');
  const lines = content.split('\n');
  const findings: Finding[] = [];
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.re.exec(content)) !== null) {
      const upto = content.slice(0, m.index);
      const lineNum = upto.split('\n').length;
      const lineStart = upto.lastIndexOf('\n') + 1;
      const col = m.index - lineStart + 1;
      findings.push({
        file: relative(root, path).replace(/\\/g, '/'),
        line: lineNum,
        column: col,
        patternId: pattern.id,
        severity: pattern.severity,
        match: m[0].slice(0, 120),
        context: (lines[lineNum - 1] ?? '').trim().slice(0, 200),
        fix: pattern.fix,
      });
      if (m[0].length === 0) pattern.re.lastIndex++;
    }
  }
  return findings;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

function renderMarkdown(target: string, findings: Finding[], totals: Record<Severity, number>): string {
  const out: string[] = [];
  out.push(`# Auditoría SQL-Server-isms\n`);
  out.push(`**Target:** \`${target}\`  `);
  out.push(`**Generado:** ${new Date().toISOString()}  `);
  out.push(`**Archivos escaneados:** see logs\n`);
  out.push(`## Resumen\n`);
  out.push(`| Severidad | Hallazgos |`);
  out.push(`|---|---:|`);
  for (const sev of ['high', 'medium', 'low', 'info'] as Severity[]) {
    out.push(`| ${sev} | ${totals[sev] ?? 0} |`);
  }
  if (findings.length === 0) {
    out.push(`\n**Limpio.** No hay construcciones SQL Server en el codebase.`);
    return out.join('\n');
  }
  out.push(`\n## Hallazgos por patrón\n`);
  const byPattern = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!byPattern.has(f.patternId)) byPattern.set(f.patternId, []);
    byPattern.get(f.patternId)!.push(f);
  }
  const sorted = [...byPattern.entries()].sort((a, b) => {
    const sa = SEVERITY_ORDER[a[1][0]!.severity] - SEVERITY_ORDER[b[1][0]!.severity];
    return sa !== 0 ? sa : b[1].length - a[1].length;
  });
  for (const [patternId, group] of sorted) {
    const first = group[0]!;
    const pat = PATTERNS.find(p => p.id === patternId)!;
    out.push(`### \`${patternId}\` (${first.severity}) — ${group.length} ocurrencias`);
    out.push(`**Qué es:** ${pat.description}  `);
    out.push(`**Cómo arreglar:** ${pat.fix}\n`);
    const sample = group.slice(0, 10);
    for (const f of sample) {
      out.push(`- \`${f.file}:${f.line}:${f.column}\` — \`${f.context.replaceAll('`', '\\`')}\``);
    }
    if (group.length > sample.length) out.push(`- _… y ${group.length - sample.length} más_`);
    out.push('');
  }
  return out.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help') {
    console.error('Uso: bun audit-mssql-isms.ts <ruta> [--json] [--severity high|medium|low|info] [--include-sql]');
    console.error('  --include-sql   también escanea archivos .sql (default: solo código de app)');
    process.exit(2);
  }
  const target = args[0]!;
  const json = args.includes('--json');
  const includeSql = args.includes('--include-sql');
  const sevFlag = args.indexOf('--severity');
  const minSev: Severity = sevFlag >= 0 ? (args[sevFlag + 1] as Severity) : 'info';

  try {
    const s = await stat(target);
    if (!s.isDirectory()) {
      console.error(`Error: ${target} no es un directorio`);
      process.exit(2);
    }
  } catch {
    console.error(`Error: no puedo leer ${target}`);
    process.exit(2);
  }

  const all: Finding[] = [];
  let fileCount = 0;
  for await (const f of walk(target, includeSql)) {
    fileCount++;
    const findings = await scanFile(f, target);
    all.push(...findings);
  }

  const filtered = all.filter(f => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[minSev]);
  const totals = filtered.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {} as Record<Severity, number>);

  if (json) {
    process.stdout.write(JSON.stringify({ target, fileCount, totals, findings: filtered }, null, 2));
  } else {
    process.stderr.write(`Escaneados ${fileCount} archivos en ${target}\n`);
    process.stdout.write(renderMarkdown(target, filtered, totals));
    process.stdout.write('\n');
  }

  const blockingCount = (totals.high ?? 0) + (totals.medium ?? 0);
  process.exit(blockingCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
