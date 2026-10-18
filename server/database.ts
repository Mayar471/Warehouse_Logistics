/** Small shared contract; local PGlite and hosted PostgreSQL use the same schema. */
export interface QueryResult<T> {
  rows: T[];
  affectedRows?: number;
}
export interface Transaction {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}
export interface Database extends Transaction {
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
