export interface QueryOperator {
    _isOperator: true;
    op: string;
    val?: any;
}

type NonFunctionKeys<T> = {
    [K in keyof T]: T[K] extends Function ? never : K;
}[keyof T];

type JSONValue<T> =
    T extends Date
    ? string
    : T extends Array<infer U>
    ? JSONValue<U>[]
    : T extends { toJSON(): infer R }
    ? R
    : T extends object
    ? { [K in keyof T]: JSONValue<T[K]> }
    : T;

export type ModelJSON<T> = {
    [K in NonFunctionKeys<T> as K extends "__relationTypes__" ? never : K]: JSONValue<T[K]>;
} & {
    pivot?: Record<string, any>;
};

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
    [lang: string]: string | null | undefined;
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
    forUpdate?: boolean;
}

type RelationItem<T> = T extends Array<infer U> ? U : T;

type DeclaredRelationTypeMap<T> =
    T extends { __relationTypes__: infer R }
    ? R extends Record<string, any>
    ? R
    : never
    : never;

type DeclaredRelationKeys<T> = Extract<keyof DeclaredRelationTypeMap<T>, keyof T>;

type FallbackRelationKeys<T> = {
    [K in keyof T]: K extends "__relationTypes__"
    ? never
    : T[K] extends Function
    ? never
    : T[K] extends Date
    ? never
    : T[K] extends Array<any>
    ? K
    : T[K] extends object
    ? K
    : never;
}[keyof T];

export type RelationKeys<T> = [DeclaredRelationKeys<T>] extends [never]
    ? FallbackRelationKeys<T>
    : DeclaredRelationKeys<T>;

type RawRelationType<T, K extends RelationKeys<T>> = [DeclaredRelationKeys<T>] extends [never]
    ? T[K]
    : K extends keyof DeclaredRelationTypeMap<T>
    ? DeclaredRelationTypeMap<T>[K]
    : never;

export type RelationModel<T, K extends RelationKeys<T>> = RelationItem<RawRelationType<T, K>>;

type PersistableModelKeys<T> = {
    [K in keyof T]: K extends "id" | "createdAt" | "__relationTypes__"
    ? never
    : K extends `__${string}`
    ? never
    : T[K] extends Function
    ? never
    : K;
}[keyof T];

type RelationMutationValue<T, K extends RelationKeys<T>> =
    T[K] extends Array<any>
    ? Array<ModelMutationData<RelationModel<T, K>> | RelationModel<T, K> | Record<string, any>>
    : ModelMutationData<RelationModel<T, K>> | RelationModel<T, K> | Record<string, any> | null;

type MutationFieldValue<T> =
    T extends Date
    ? Date | string | null
    : T extends Array<infer U>
    ? Array<MutationFieldValue<U> | U>
    : T extends object
    ? T extends Function
    ? never
    : (Partial<{
        [K in keyof T as T[K] extends Function ? never : K]: MutationFieldValue<T[K]>;
    }> | T | null)
    : T;

export type ModelMutationData<T> = Partial<{
    [K in PersistableModelKeys<T>]: K extends RelationKeys<T>
    ? RelationMutationValue<T, Extract<K, RelationKeys<T>>>
    : MutationFieldValue<T[K]>;
}>;

export interface RelationNode<T> extends SoftDeleteQueryOptions {
    where?: WhereCondition<T>;
    pivotWhere?: Record<string, any>;
    relations?: RelationSpec<T>;
    select?: (keyof T)[];
    orderBy?: OrderByClause<T>[];
    forUpdate?: boolean;
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
    [K in RelationKeys<T>]?: RelationNode<RelationModel<T, K>> | true;
};

export type LoadRelationOptions<T, K extends RelationKeys<T>> = RelationNode<RelationModel<T, K>>;

export interface SaveOptions<T> {
    relations?: RelationSpec<T>;
}

export interface CreateOptions<T> extends SaveOptions<T> { }

export interface UpdateOptions<T> extends SaveOptions<T>, SoftDeleteQueryOptions {
    forUpdate?: boolean;
}

export interface SyncOptions<T> extends UpdateOptions<T> {
    deleteMissing?: boolean;
}

export interface DeleteWhereOptions<T> extends DeleteOptions<T>, SoftDeleteQueryOptions {
    forUpdate?: boolean;
    force?: boolean;
}

export type SyncByKey<T> = Extract<keyof T, string>;

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
 *
 * Strict relation typing requires each model to declare a type-only relation map:
 *
 * declare __relationTypes__: {
 *   payment: PackageReservationPayment;
 *   items: PackageReservationItem[];
 *   guests: Guest[];
 * };
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

    toJSON(): ModelJSON<this>;
}

export interface IActiveRecord extends IModel { }

export interface IModelStatic<T extends IModel = IModel> {
    new (): T;

    create(data?: ModelMutationData<T>, options?: CreateOptions<T>): T;

    update(
        idOrWhere: string | WhereCondition<T>,
        data: ModelMutationData<T>,
        options?: UpdateOptions<T>
    ): T;

    batchInsert(records: Array<T | ModelMutationData<T>>): T[];
    batchUpdate(records: Array<T | ModelMutationData<T>>): void;

    sync(
        where: WhereCondition<T>,
        records: Array<ModelMutationData<T>>,
        options?: SyncOptions<T>
    ): T[];

    syncBy(
        where: WhereCondition<T>,
        records: Array<ModelMutationData<T>>,
        by?: SyncByKey<T>[],
        options?: SyncOptions<T>
    ): T[];

    delete(
        where: string | WhereCondition<T>,
        options?: DeleteWhereOptions<T>
    ): number;
}
