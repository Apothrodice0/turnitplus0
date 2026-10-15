// Minimal declarations for Node 22's built-in `node:sqlite` (the installed @types/node predates it). Only the surface
// the ASJP catalog store and snapshot use; runtime is Node's own module.
declare module "node:sqlite" {
  export type SupportedValueType = null | number | bigint | string | Uint8Array;
  export class StatementSync {
    get(...params: SupportedValueType[]): Record<string, unknown> | undefined;
    all(...params: SupportedValueType[]): Array<Record<string, unknown>>;
    run(...params: SupportedValueType[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(location: string | URL, options?: { open?: boolean; readOnly?: boolean; timeout?: number; enableForeignKeyConstraints?: boolean });
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
