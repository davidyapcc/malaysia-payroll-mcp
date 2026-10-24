import {
  type McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { allTables, type RateTable, type TableKind } from "../tables/index.js";

export const TABLE_URI_TEMPLATE = "payroll://tables/{kind}/{effectiveFrom}";

const MIME_TYPE = "application/json";

const TITLES: Readonly<Record<TableKind, string>> = {
  epf: "EPF Third Schedule",
  socso: "SOCSO (Act 4) contribution table",
  skbbk: "SKBBK (Lindung 24 Jam) contribution table",
  eis: "EIS (Act 800) contribution table",
};

export function tableUri(table: RateTable): string {
  return `payroll://tables/${table.kind}/${table.effectiveFrom}`;
}

function describe(table: RateTable): string {
  return `${TITLES[table.kind]} in effect from ${table.effectiveFrom}, transcribed from ${table.source.title}. Amounts are in sen; a band covers wages above "above" and up to and including "upTo".`;
}

/**
 * Exposes every generated rate table read-only, so a client can show or check the exact band a
 * citation points at. The tables are the generated modules as they are: amounts stay in sen.
 */
export function registerTableResources(server: McpServer): void {
  server.registerResource(
    "rate-table",
    new ResourceTemplate(TABLE_URI_TEMPLATE, {
      list: () => ({
        resources: allTables.map((table) => ({
          uri: tableUri(table),
          name: `${table.kind}-${table.effectiveFrom}`,
          title: `${TITLES[table.kind]} from ${table.effectiveFrom}`,
          description: describe(table),
          mimeType: MIME_TYPE,
        })),
      }),
      complete: {
        kind: (value) =>
          [...new Set(allTables.map((t) => t.kind))].filter((k) => k.startsWith(value)),
        effectiveFrom: (value, context) => {
          const kind = context?.arguments?.kind;
          const dates = allTables
            .filter((t) => kind === undefined || t.kind === kind)
            .map((t) => t.effectiveFrom)
            .filter((date) => date.startsWith(value));
          return [...new Set(dates)].sort();
        },
      },
    }),
    {
      title: "Malaysian payroll rate table",
      description:
        "A statutory contribution table (kind epf, socso, skbbk or eis) by the date it takes effect, as JSON. Amounts are in sen.",
      mimeType: MIME_TYPE,
    },
    (uri, variables) => {
      // Plain {var} expressions always match as strings.
      const kind = String(variables.kind);
      const effectiveFrom = String(variables.effectiveFrom);
      const table = allTables.find((t) => t.kind === kind && t.effectiveFrom === effectiveFrom);
      if (table === undefined) throw new ResourceNotFoundError(uri.href);
      return {
        contents: [{ uri: uri.href, mimeType: MIME_TYPE, text: JSON.stringify(table, null, 2) }],
      };
    },
  );
}
