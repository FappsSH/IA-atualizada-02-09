// Mock mínimo do client Supabase para testes de integração das Edge Functions.
// Captura inserts/upserts/updates por tabela; suporta from().select().eq().maybeSingle(),
// from().insert(), from().upsert(), from().update().eq(), from().delete().eq().

export interface MockTable {
    rows: Record<string, unknown>[];
    inserts: Record<string, unknown>[][];
    upserts: Record<string, unknown>[][];
    updates: { match: Record<string, unknown>; patch: Record<string, unknown> }[];
}

export interface SupabaseMock {
    tables: Record<string, MockTable>;
    rpcs: { name: string; args: unknown }[];
    from(table: string): any;
    rpc(name: string, args?: unknown): any;
    _reset(): void;
}

function makeTable(): MockTable {
    return { rows: [], inserts: [], upserts: [], updates: [] };
}

export function createSupabaseMock(seed: Record<string, Record<string, unknown>[]> = {}): SupabaseMock {
    const tables: Record<string, MockTable> = {};
    for (const [k, rows] of Object.entries(seed)) {
        tables[k] = { ...makeTable(), rows: [...rows] };
    }
    const rpcs: { name: string; args: unknown }[] = [];

    function ensureTable(name: string): MockTable {
        if (!tables[name]) tables[name] = makeTable();
        return tables[name];
    }

    function builder(tableName: string) {
        const tbl = ensureTable(tableName);
        let filters: Array<(r: any) => boolean> = [];
        const apply = () => tbl.rows.filter((r) => filters.every((f) => f(r)));

        const chain: any = {
            select: () => chain,
            eq: (col: string, val: unknown) => {
                filters.push((r) => r[col] === val);
                return chain;
            },
            gte: (col: string, val: any) => {
                filters.push((r) => r[col] !== null && r[col] !== undefined && r[col] >= val);
                return chain;
            },
            in: (col: string, vals: unknown[]) => {
                filters.push((r) => vals.includes(r[col]));
                return chain;
            },
            order: () => chain,
            limit: () => chain,
            maybeSingle: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
            single: () => Promise.resolve({ data: apply()[0] ?? null, error: null }),
            then: (resolve: any) => Promise.resolve({ data: apply(), error: null }).then(resolve),
            insert: (rows: any) => {
                const arr = Array.isArray(rows) ? rows : [rows];
                tbl.inserts.push(arr);
                tbl.rows.push(...arr);
                return Promise.resolve({ data: arr, error: null });
            },
            upsert: (rows: any, _opts?: any) => {
                const arr = Array.isArray(rows) ? rows : [rows];
                tbl.upserts.push(arr);
                tbl.rows.push(...arr);
                return Promise.resolve({ data: arr, error: null });
            },
            update: (patch: Record<string, unknown>) => ({
                eq: (col: string, val: unknown) => {
                    const match = { [col]: val };
                    tbl.updates.push({ match, patch });
                    for (const r of tbl.rows) if (r[col] === val) Object.assign(r as object, patch);
                    return Promise.resolve({ data: null, error: null });
                },
            }),
            delete: () => ({
                eq: (col: string, val: unknown) => {
                    tbl.rows = tbl.rows.filter((r) => r[col] !== val);
                    return Promise.resolve({ data: null, error: null });
                },
            }),
        };
        return chain;
    }

    return {
        tables,
        rpcs,
        from: builder,
        rpc: (name: string, args?: unknown) => {
            rpcs.push({ name, args });
            return Promise.resolve({ data: null, error: null });
        },
        _reset() {
            for (const t of Object.keys(tables)) tables[t] = makeTable();
            rpcs.length = 0;
        },
    };
}
