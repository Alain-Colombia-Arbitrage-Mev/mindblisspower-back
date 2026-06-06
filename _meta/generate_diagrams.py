"""Generate DBML + Mermaid ER diagrams (per domain) from SQL Server metadata TSVs."""
from collections import defaultdict
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[2]
META = Path(__file__).resolve().parent
OUT_DBML = WORKSPACE / "backend" / "legacy" / "vicionpower.dbml"
OUT_MD = WORKSPACE / "docs" / "vicionpower_diagrams.md"

DOMAINS = {
    "Identity & KYC": [
        "person", "vicionario", "vicionarioKyc", "vicionarioKycInfoMatched",
        "vicionarioAddress", "vicionarioDocument", "vicionarioLegalDocument",
        "vicionarioNewUserMigracion", "blackList", "businessProfile",
        "businessAddress", "document", "legalDocument", "legalDocumentField",
    ],
    "Wallet & Movements": [
        "wallet", "asset", "movement", "concept", "vicionarioMoneyAccount",
    ],
    "MLM Network & Bonuses": [
        "logDetailVicionarioNetwork", "logVicionarioNetwork",
        "logVicionarioPointsHistory", "logVicionarioNetworkSystem",
        "vicionarioRankRecord", "vicionarioLeadershipBonusRecord", "rank",
    ],
    "Packages & Coupons": [
        "package", "vicionarioPackage", "vicionarioPackagePermission",
        "vicionarioPackageAvailableMovement", "couponPackage", "coupon",
    ],
    "Payments & Banking": [
        "bank", "bankAccount", "bank_country", "withdrawalRequest", "country",
    ],
    "Loans": ["loan", "loanRequest", "logRoi"],
    "Support & Tickets": [
        "ticket", "ticketTracker", "ticketAssignmentTracking",
    ],
    "Communications": [
        "message", "messageDetail", "notification", "notificationDetail",
        "news", "watchedNews", "mediaResource",
    ],
    "RBAC / Auth": [
        "role", "roleModule", "module", "moduleAction",
        "modulePermission", "moduleActionPermission",
    ],
    "Catalogs & Config": [
        "parameter", "catalog", "validationRules", "testimonial",
    ],
    "Audit Logs": [
        "logActivity", "logPersonStatus", "logPersonHistory",
        "logVicionarioKycHistory", "logVicionarioKycStatus",
        "logDeleteInactivePerson",
    ],
}

# --- load metadata ---
def read_tsv(path):
    rows = []
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for ln in f:
            ln = ln.rstrip("\n").rstrip("\r")
            if not ln.strip():
                continue
            rows.append(ln.split("\t"))
    return rows

cols_raw = read_tsv(META / "columns.tsv")
pks_raw = read_tsv(META / "pks.tsv")
fks_raw = read_tsv(META / "fks.tsv")
sizes_raw = read_tsv(META / "sizes.tsv")

# table -> [(col, type, max_len, prec, scale, nullable, identity, ord)]
columns = defaultdict(list)
for r in cols_raw:
    if len(r) < 9:
        continue
    t, c, dt, ml, prec, scale, null, ident, ordn = r[:9]
    columns[t].append({
        "name": c, "type": dt,
        "max_len": int(ml), "prec": int(prec), "scale": int(scale),
        "nullable": null == "1", "identity": ident == "1", "ord": int(ordn),
    })

pks = defaultdict(set)
for r in pks_raw:
    if len(r) >= 2:
        pks[r[0]].add(r[1])

# fks: from_table, from_col, to_table, to_col, name
fks = []
fk_cols = defaultdict(set)  # (table, col) -> set of (ref_table)
for r in fks_raw:
    if len(r) >= 5:
        fks.append({
            "from_t": r[0], "from_c": r[1],
            "to_t": r[2], "to_c": r[3], "name": r[4],
        })
        fk_cols[(r[0], r[1])].add(r[2])

sizes = {}
for r in sizes_raw:
    if len(r) >= 3:
        try:
            sizes[r[0]] = (int(r[1]), int(r[2]))  # rows, kb
        except ValueError:
            pass

all_tables = sorted(columns.keys())

# --- type formatting ---
def fmt_type(c):
    dt = c["type"]
    ml = c["max_len"]
    if dt in ("nvarchar", "nchar"):
        n = "MAX" if ml == -1 else str(ml // 2)
        return f"{dt}({n})"
    if dt in ("varchar", "char", "varbinary", "binary"):
        n = "MAX" if ml == -1 else str(ml)
        return f"{dt}({n})"
    if dt in ("decimal", "numeric"):
        return f"{dt}({c['prec']},{c['scale']})"
    return dt

# --- DBML ---
def gen_dbml():
    out = ["// vicionpower schema — generated from SQL Server (viciongroup)\n",
           "// Paste into https://dbdiagram.io/d for an interactive ER diagram\n\n"]
    # group tables by domain via TableGroup blocks
    seen_in_domain = set()
    for domain, tabs in DOMAINS.items():
        present = [t for t in tabs if t in columns]
        seen_in_domain.update(present)
        if present:
            out.append(f"TableGroup \"{domain}\" {{\n")
            for t in present:
                out.append(f"  {t}\n")
            out.append("}\n\n")
    # any tables not in a domain
    leftover = [t for t in all_tables if t not in seen_in_domain]
    if leftover:
        out.append("TableGroup \"Misc\" {\n")
        for t in leftover:
            out.append(f"  {t}\n")
        out.append("}\n\n")

    for t in all_tables:
        rows, kb = sizes.get(t, (0, 0))
        note = f"rows: {rows:,} | size: {kb:,} KB"
        out.append(f"Table {t} [note: '{note}'] {{\n")
        for c in sorted(columns[t], key=lambda x: x["ord"]):
            attrs = []
            if c["name"] in pks.get(t, set()):
                attrs.append("pk")
            if c["identity"]:
                attrs.append("increment")
            if not c["nullable"] and c["name"] not in pks.get(t, set()):
                attrs.append("not null")
            attrs_s = f" [{', '.join(attrs)}]" if attrs else ""
            out.append(f"  {c['name']} {fmt_type(c)}{attrs_s}\n")
        out.append("}\n\n")

    out.append("\n// --- Foreign keys ---\n")
    for fk in fks:
        out.append(f"Ref: {fk['from_t']}.{fk['from_c']} > {fk['to_t']}.{fk['to_c']}\n")

    OUT_DBML.write_text("".join(out), encoding="utf-8")

# --- Mermaid per domain ---
def short_type(c):
    dt = c["type"]
    if dt in ("varchar", "nvarchar", "char", "nchar"):
        ml = c["max_len"]
        n = "max" if ml == -1 else (ml // 2 if dt.startswith("n") else ml)
        return f"{dt}_{n}"
    if dt in ("decimal", "numeric"):
        return f"{dt}_{c['prec']}_{c['scale']}"
    return dt

def gen_mermaid_for(name, tabs):
    present = [t for t in tabs if t in columns]
    if not present:
        return ""
    set_present = set(present)
    lines = [f"## {name}\n",
             f"_{len(present)} tablas — "]
    total_rows = sum(sizes.get(t, (0, 0))[0] for t in present)
    total_kb = sum(sizes.get(t, (0, 0))[1] for t in present)
    lines.append(f"{total_rows:,} filas, {total_kb / 1024:.1f} MB_\n\n")
    lines.append("```mermaid\nerDiagram\n")
    for t in present:
        lines.append(f"  {t} {{\n")
        for c in sorted(columns[t], key=lambda x: x["ord"]):
            tags = ""
            if c["name"] in pks.get(t, set()):
                tags = " PK"
            elif (t, c["name"]) in fk_cols:
                tags = " FK"
            lines.append(f"    {short_type(c)} {c['name']}{tags}\n")
        lines.append("  }\n")
    # FK relations within domain + cross-domain hints
    cross = []
    for fk in fks:
        if fk["from_t"] in set_present and fk["to_t"] in set_present:
            lines.append(f"  {fk['from_t']} }}o--|| {fk['to_t']} : \"{fk['from_c']}\"\n")
        elif fk["from_t"] in set_present and fk["to_t"] not in set_present:
            cross.append((fk["from_t"], fk["from_c"], fk["to_t"]))
        elif fk["to_t"] in set_present and fk["from_t"] not in set_present:
            cross.append((fk["from_t"], fk["from_c"], fk["to_t"]))
    lines.append("```\n")
    if cross:
        lines.append("\n**Referencias cruzadas a otros dominios:**\n\n")
        seen = set()
        for f, c, t in cross:
            key = (f, c, t)
            if key in seen:
                continue
            seen.add(key)
            lines.append(f"- `{f}.{c}` → `{t}`\n")
        lines.append("\n")
    return "".join(lines)

def gen_mermaid_md():
    parts = ["# vicionpower — Diagramas ER por dominio\n\n",
             "Generados desde el schema SQL Server (`viciongroup`). "
             "Visualizables directamente en VS Code (extensión Markdown Preview Mermaid Support), GitHub o Notion.\n\n",
             "## Resumen\n\n",
             f"- **{len(all_tables)} tablas**\n",
             f"- **{len(fks)} foreign keys**\n",
             f"- **{sum(r for r, _ in sizes.values()):,} filas totales**\n",
             f"- **{sum(k for _, k in sizes.values()) / 1024:.1f} MB datos+índices**\n\n",
             "Para diagrama interactivo del esquema completo, abrir `backend/legacy/vicionpower.dbml` en https://dbdiagram.io.\n\n",
             "---\n\n"]
    for domain, tabs in DOMAINS.items():
        block = gen_mermaid_for(domain, tabs)
        if block:
            parts.append(block)
            parts.append("\n---\n\n")
    # leftover
    seen = {t for tabs in DOMAINS.values() for t in tabs}
    leftover = [t for t in all_tables if t not in seen]
    if leftover:
        parts.append(gen_mermaid_for("Misc / Sin clasificar", leftover))
    OUT_MD.write_text("".join(parts), encoding="utf-8")

gen_dbml()
gen_mermaid_md()
print(f"DBML  -> {OUT_DBML} ({OUT_DBML.stat().st_size:,} bytes)")
print(f"MD    -> {OUT_MD} ({OUT_MD.stat().st_size:,} bytes)")
print(f"Tables: {len(all_tables)} | FKs: {len(fks)}")
