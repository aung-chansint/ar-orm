declare module "context" {
  export interface HttpResponse {
    setStatusCode(code: number): void;
    setBody(body: any): void;
  }

  export interface HttpContext {
    response: HttpResponse;
  }

  export function getUserId(): string;
  export function getHttp(): HttpContext;
}

declare module "uuid" {
  export function v4(): string;
}

declare module "db" {
  export enum Conjunction {
    AND = "and",
    OR = "or",
  }

  export enum Order {
    ASC = "asc",
    DESC = "desc",
  }

  export interface ConditionOperator {
    field?: string;
    operator?: string;
    value?: any;
    conjunction?: Conjunction;
    conditions?: Conditions[];
    condition?: Condition;
  }

  export interface Condition {
    conjunction: Conjunction;
    conditions: Conditions[];
  }

  export type Conditions = Condition | ConditionOperator;

  export interface DynamicObject {
    insert(data: any): string | number;
    update(id: string | number, data: any): void;
    query(id: string | number): any;
    delete(id: string | number): void;
    count(condition?: Condition): number;
    queryByCondition(condition: Condition | Record<string, never>, query?: { options?: any }): any[];
    deleteByCondition(condition: Condition): void;
    batchInsert(rows: any[], options?: any): string[];
    batchUpdate(rows: any[]): void;
  }

  export function setup(tableName: string): DynamicObject;
  export function dynamicObject(tableName: string): DynamicObject;
  export function rollback(): void;
}
