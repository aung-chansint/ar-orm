export interface QueryOperator {
    _isOperator: true;
    op: string;
    val?: any;
}

export const Op = {
    Eq: (v: any): QueryOperator => ({ _isOperator: true, op: "eq", val: v }),
    Ne: (v: any): QueryOperator => ({ _isOperator: true, op: "ne", val: v }),
    Gt: (v: any): QueryOperator => ({ _isOperator: true, op: "gt", val: v }),
    Ge: (v: any): QueryOperator => ({ _isOperator: true, op: "ge", val: v }),
    Lt: (v: any): QueryOperator => ({ _isOperator: true, op: "lt", val: v }),
    Le: (v: any): QueryOperator => ({ _isOperator: true, op: "le", val: v }),
    In: (v: any[]): QueryOperator => ({ _isOperator: true, op: "in", val: v }),
    IsNull: (): QueryOperator => ({ _isOperator: true, op: "isnull" }),
    IsNotNull: (): QueryOperator => ({ _isOperator: true, op: "isnotnull" }),
    Contains: (v: string): QueryOperator => ({ _isOperator: true, op: "contains", val: v }),
    StartsWith: (v: string): QueryOperator => ({ _isOperator: true, op: "startwith", val: v }),
    EndsWith: (v: string): QueryOperator => ({ _isOperator: true, op: "endwith", val: v }),
    Includes: (v: string[]): QueryOperator => ({ _isOperator: true, op: "includes", val: v }),
    Excludes: (v: string[]): QueryOperator => ({ _isOperator: true, op: "excludes", val: v }),
    Search: (v: string): QueryOperator => ({ _isOperator: true, op: "search", val: v }),
};

export interface MLValue {
    en_US?: string;
    zh_CN?: string;
    my_MM?: string;
    [lang: string]: string | undefined;
}

export type ColumnKeys<T> = {
    [K in keyof T]: T[K] extends Function
    ? never
    : K extends
    | "id"
    | "createdAt"
    | "updatedAt"
    | "createdBy"
    | "updatedBy"
    | "deletedAt"
    | "deletedBy"
    ? never
    : K;
}[keyof T];

export type SelectResult<T, K extends keyof T> = Pick<T, K> & T;

export type WhereCondition<T> = {
    [K in keyof T]?: T[K] | QueryOperator | null;
} & {
    id?: string | QueryOperator | null;
} | {
    OR: WhereCondition<T>[];
}
    | {
        AND: WhereCondition<T>[];
    }
    | {
        NOT: WhereCondition<T>;
    };

export interface OrderByClause<T> {
    field: keyof T | "id" | "createdAt" | "updatedAt";
    order: "ASC" | "DESC";
}

export interface SoftDeleteQueryOptions {
    withSoftDeleted?: boolean;
    onlySoftDeleted?: boolean;
}

export interface FindOptions<T, K extends keyof T = never> extends SoftDeleteQueryOptions {
    where?: WhereCondition<T>;
    orderBy?: OrderByClause<T>[];
    limit?: number;
    offset?: number;
    select?: K[];
}

export type RelationKeys<T> = {
    [K in keyof T]: T[K] extends Array<any>
    ? K
    : T[K] extends object
    ? K
    : never;
}[keyof T];

export interface RelationNode<T> extends SoftDeleteQueryOptions {
    where?: WhereCondition<T>;
    pivotWhere?: Record<string, any>;
    relations?: RelationSpec<T>;
    select?: (keyof T)[];
    orderBy?: OrderByClause<T>[];
    /**
     * Per-parent relation limit.
     *
     * Example:
     * User.findWithRelations({
     *   relations: { posts: { limit: 5 } }
     * })
     *
     * means max 5 posts per user, not 5 posts total.
     */
    limit?: number;
}

export type RelationSpec<T> = {
    [K in keyof T]?: RelationNode<T[K] extends Array<infer U> ? U : T[K]> | true;
};

export type LoadRelationOptions<T, K extends keyof T> =
    T[K] extends Array<infer U>
    ? RelationNode<U>
    : T[K] extends object
    ? RelationNode<T[K]>
    : never;

export interface SaveOptions<T> {
    relations?: RelationSpec<T>;
}

export interface DeleteOptions<T> {
    relations?: RelationSpec<T>;
}

export interface RestoreOptions<T> {
    relations?: RelationSpec<T>;
}

export interface FindWithRelationsOptions<T, K extends keyof T = never>
    extends FindOptions<T, K> {
    relations?: RelationSpec<T>;
}

/**
 * Public model API only.
 *
 * Internal fields like __dirtyFields, __isNew, __pivot, etc.
 * are intentionally NOT here, so they do not appear in normal type hints.
 */
export interface IModel {
    id?: string;
    createdAt?: Date;

    save(options?: SaveOptions<this>): void;
    delete(options?: DeleteOptions<this>): void;
    forceDelete(options?: DeleteOptions<this>): void;
    restore(options?: RestoreOptions<this>): void;
    reload(): this;

    isDirty(field?: string): boolean;
    isNew(): boolean;
    getDirtyFields(): string[];
    getDirtyRelations(): string[];

    loadRelation<K extends RelationKeys<this>>(
        relationName: K,
        options?: LoadRelationOptions<this, K>
    ): this;

    loadRelations(spec: RelationSpec<this>): this;

    withPivot(data: Record<string, any>): this;
    getPivot<T extends Record<string, any> = Record<string, any>>(): T | undefined;

    toJSON(): Record<string, any>;
}

export interface IActiveRecord extends IModel { }