import * as db from "db";
import { getUserId } from "context";
import {
    getTableName,
    getColumns,
    getRelations,
    ColumnMeta,
    RelationMeta,
} from "./MBTI__ARDecorators";
import type {
    IModel,
    MLValue,
    WhereCondition,
    FindOptions,
    FindWithRelationsOptions,
    RelationSpec,
    RelationNode,
    SaveOptions,
    DeleteOptions,
    RestoreOptions,
    LoadRelationOptions,
    RelationKeys,
    QueryOperator,
} from "./MBTI__ARTypes";
import { MLHelper } from "./MBTI__MLHelper";
import {
    ORMError,
    ORMDuplicateError,
    ORMNotFoundError,
    ORMRequiredFieldError,
    ORMValidationError,
} from "./MBTI__ARError";

export { Op } from "./MBTI__ARTypes";
export type { MLValue } from "./MBTI__ARTypes";

const DEFAULT_LIMIT = 3000;
const BATCH_CHUNK_SIZE = 200;
const RELATION_ID_CHUNK_SIZE = 300;
const RELATION_PAGE_SIZE = 3000;
const RELATION_MAX_ROWS = 50000;

const SYSTEM_FIELD_MAP: Record<string, string> = {
    createdAt: "createdDate",
    updatedAt: "lastModifiedDate",
    createdBy: "createdBy",
    updatedBy: "lastModifiedBy",
};

const TYPE_OP_MAP: Record<string, string[]> = {
    text: ["eq", "ne", "le", "ge", "lt", "gt", "contains", "startwith", "endwith", "isnull", "isnotnull"],
    encryptedText: ["search"],
    textArea: ["isnull", "isnotnull"],
    number: ["eq", "ne", "le", "ge", "lt", "gt", "in", "isnull", "isnotnull"],
    percent: ["eq", "ne", "le", "ge", "lt", "gt", "in", "isnull", "isnotnull"],
    currency: ["eq", "ne", "le", "ge", "lt", "gt", "in", "isnull", "isnotnull"],
    date: ["eq", "ne", "le", "ge", "lt", "gt", "in", "isnull", "isnotnull"],
    datetime: ["eq", "ne", "le", "ge", "lt", "gt", "in", "isnull", "isnotnull"],
    email: ["eq", "ne", "in", "contains", "startwith", "endwith", "isnull", "isnotnull"],
    phone: ["eq", "ne", "le", "ge", "lt", "gt", "in", "contains", "startwith", "endwith", "isnull", "isnotnull"],
    url: ["eq", "ne", "le", "ge", "lt", "gt", "in", "contains", "startwith", "endwith", "isnull", "isnotnull"],
    checkbox: ["eq", "ne", "isnull", "isnotnull"],
    picklist: ["eq", "ne", "isnull", "isnotnull"],
    picklistMulti: ["eq", "ne", "includes", "excludes", "isnull", "isnotnull"],
    multiLanguage: ["eq", "ne", "in", "isnull", "isnotnull"],
};

type ModelClass<T extends Model> = (new () => T) & typeof Model;

function toUtcISOString(val: any): string {
    if (val instanceof Date) return val.toISOString();
    if (typeof val === "string") return new Date(val).toISOString();

    throw new ORMValidationError({
        date: `Invalid date value: ${val}`,
    });
}

function toDateOrNull(val: any): Date | null {
    if (val === null || val === undefined || val === "") return null;
    if (val instanceof Date) return val;
    return new Date(val);
}

function _hasEmptyIn(where: Record<string, any>): boolean {
    for (const val of Object.values(where)) {
        if (
            val !== null &&
            typeof val === "object" &&
            !Array.isArray(val) &&
            val._isOperator === true &&
            val.op === "in" &&
            Array.isArray(val.val) &&
            val.val.length === 0
        ) {
            return true;
        }
    }

    return false;
}

function _isOrmOrValidationError(err: any): boolean {
    return err instanceof ORMError || err instanceof ORMValidationError;
}

function _handleCaughtError(
    err: any,
    retry: () => void,
    canRetry: boolean,
    dbHandler: () => never
): never | void {
    db.rollback();

    if (_isOrmOrValidationError(err)) {
        throw err;
    }

    const msg = (err?.message ?? "").toLowerCase();

    if (msg.includes("deadlock")) {
        if (canRetry) {
            retry();
            return;
        }

        throw new ORMError(
            "DeadlockError",
            "Deadlock detected after retry — please try again later",
            503
        );
    }

    if (msg.includes("unique") || msg.includes("duplicate")) {
        throw new ORMDuplicateError("field");
    }

    // Preserve custom validator errors like Error("banned name").
    if (err instanceof Error && err.name === "Error") {
        throw err;
    }

    dbHandler();
}

export class Model implements IModel {
    id?: string;
    createdAt?: Date;

    protected __pivot?: Record<string, any>;
    protected __dirtyFields: Set<string> = new Set();
    protected __relationDirty: Set<string> = new Set();
    protected __isNew: boolean = true;
    protected __selectedFields?: Set<string>;
    protected __originalValues?: Map<string, any> = new Map();
    private static __schemaValidatedModels: Set<string> = new Set();

    private static __columnsCache: Map<Function, ColumnMeta[]> = new Map();
    private static __relationsCache: Map<Function, RelationMeta[]> = new Map();

    constructor() {
        this.__originalValues = new Map();

        return new Proxy(this, {
            set(target: any, prop: string | symbol, value: any): boolean {
                const propStr = String(prop);

                if (
                    propStr.startsWith("__") ||
                    propStr === "id" ||
                    propStr === "createdAt"
                ) {
                    target[propStr] = value;
                    return true;
                }

                const ctor = target.constructor;
                const columns = Model._cachedColumns(ctor);
                const relations = Model._cachedRelations(ctor);

                const isColumn = columns.some(c => c.propertyName === propStr);
                const isRelation = relations.some(r => r.propertyName === propStr);

                if (value !== undefined) {
                    if (isColumn) {
                        if (!target.__selectedFields || target.__selectedFields.has(propStr)) {
                            target.__dirtyFields.add(propStr);
                        }
                    } else if (isRelation) {
                        target.__relationDirty.add(propStr);
                    }
                }

                target[propStr] = value;
                return true;
            },
        });
    }

    private _getColumns(): ColumnMeta[] {
        return Model._cachedColumns(this.constructor as Function);
    }

    private _getRelations(): RelationMeta[] {
        return Model._cachedRelations(this.constructor as Function);
    }

    private _hasSoftDelete(): boolean {
        return !!(this.constructor as typeof Model)._deletedAtColumn();
    }

    private static _cachedColumns(ctor: Function): ColumnMeta[] {
        const cached = Model.__columnsCache.get(ctor);
        if (cached) return cached;

        const cols = _walkColumns(ctor);
        Model.__columnsCache.set(ctor, cols);
        return cols;
    }

    private static _cachedRelations(ctor: Function): RelationMeta[] {
        const cached = Model.__relationsCache.get(ctor);
        if (cached) return cached;

        const rels = _walkRelations(ctor);
        Model.__relationsCache.set(ctor, rels);
        return rels;
    }

    private static _warmModelCache(ctor: typeof Model): void {
        Model._ensureSchemaValidFor(ctor);
        ctor._columns();
        ctor._relations();
    }

    static _tableName(): string {
        const name = getTableName(this);

        if (!name) {
            throw new ORMValidationError({
                entity: `Entity '${this.name}' is missing @Entity decorator.`,
            });
        }

        return name;
    }

    static _columns(): ColumnMeta[] {
        const result: ColumnMeta[] = [];
        let proto: Function = this;

        while (proto && proto !== Function.prototype) {
            for (const col of getColumns(proto)) {
                if (!result.find(c => c.propertyName === col.propertyName)) {
                    result.push(col);
                }
            }

            proto = Object.getPrototypeOf(proto);
        }

        return result;
    }

    static _relations(): RelationMeta[] {
        const result: RelationMeta[] = [];
        let proto: Function = this;

        while (proto && proto !== Function.prototype) {
            for (const rel of getRelations(proto)) {
                if (!result.find(r => r.propertyName === rel.propertyName)) {
                    result.push(rel);
                }
            }

            proto = Object.getPrototypeOf(proto);
        }

        return result;
    }

    private static _serializePivotValue(value: any, colMeta: ColumnMeta | undefined): any {
        if (colMeta?.type === "date" && value !== null && value !== undefined) {
            return toDateOnlyString(value);
        }

        if (colMeta?.type === "datetime" && value !== null && value !== undefined) {
            return toUtcISOString(value);
        }

        if (colMeta?.type === "picklistMulti" && Array.isArray(value)) {
            return value.join(";");
        }

        return value;
    }

    private static _pivotValuesEqual(a: any, b: any): boolean {
        if (a instanceof Date) a = a.getTime();
        if (b instanceof Date) b = b.getTime();

        if (Array.isArray(a) || Array.isArray(b)) {
            return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        }

        return a === b;
    }

    private _syncManyToManyRelation(
        rel: RelationMeta,
        value: any,
        childSpec?: Record<string, any>
    ): void {
        if (!this.id) {
            throw new ORMValidationError({
                [rel.propertyName]: "Cannot save ManyToMany relation before parent has an id.",
            });
        }

        if (!rel.pivotEntity || !rel.pivotLocalKey || !rel.pivotForeignKey) {
            throw new ORMValidationError({
                [rel.propertyName]: "ManyToMany relation needs pivotEntity, pivotLocalKey, and pivotForeignKey.",
            });
        }

        const PivotClass = rel.pivotEntity() as ModelClass<Model>;
        const pivotTable = PivotClass._tableName();
        const pivotColumns = PivotClass._columns();
        const pivotHasSoftDelete = !!PivotClass._deletedAtColumn();

        const localColMeta = pivotColumns.find(c => c.propertyName === rel.pivotLocalKey);
        const foreignColMeta = pivotColumns.find(c => c.propertyName === rel.pivotForeignKey);

        if (!localColMeta || !foreignColMeta) {
            throw new ORMValidationError({
                [rel.propertyName]: "Pivot keys not found in pivot entity.",
            });
        }

        const obj = db.dynamicObject(pivotTable);

        const deletePivot = (pivot: Model): void => {
            if (!pivot.id) {
                throw new ORMValidationError({
                    [rel.propertyName]: "Existing pivot row has no id.",
                });
            }

            if (pivotHasSoftDelete) {
                const deletedAtCol = PivotClass._deletedAtColumn();
                const deletedByCol = PivotClass._deletedByColumn();

                if (!deletedAtCol) {
                    obj.delete(pivot.id);
                    return;
                }

                const dbData: any = {
                    [deletedAtCol.columnName]: new Date().toISOString(),
                };

                if (deletedByCol) {
                    dbData[deletedByCol.columnName] = getUserId();
                }

                obj.update(pivot.id, dbData);
                return;
            }

            obj.delete(pivot.id);
        };

        const items = Array.isArray(value) ? value : [];

        const desiredByForeignId = new Map<string, {
            foreignId: string;
            pivotExtra: Record<string, any>;
        }>();

        for (const item of items) {
            if (
                item instanceof Model &&
                (!item.id || item.__dirtyFields.size > 0 || item.__relationDirty.size > 0)
            ) {
                item.save(childSpec ? { relations: childSpec } : undefined);
            }

            const foreignId = item instanceof Model ? item.id : item?.id;

            if (!foreignId) {
                throw new ORMValidationError({
                    [rel.propertyName]: "ManyToMany related item must have an id.",
                });
            }

            const pivotExtra =
                item instanceof Model
                    ? (item.getPivot() ?? (item as any).__pivot ?? {})
                    : (item.__pivot ?? {});

            desiredByForeignId.set(String(foreignId), {
                foreignId: String(foreignId),
                pivotExtra,
            });
        }

        const existingRaw = Model._queryAllRaw(
            PivotClass,
            { [rel.pivotLocalKey]: this.id } as any,
            { relationName: `${rel.propertyName}:pivot-save` }
        );

        const existingPivots = Model._mapRawList(PivotClass, existingRaw);
        const existingByForeignId = new Map<string, Model>();
        const duplicatePivots: Model[] = [];

        for (const pivot of existingPivots) {
            const foreignId = (pivot as any)[rel.pivotForeignKey];

            if (foreignId === null || foreignId === undefined || foreignId === "") continue;

            const key = String(foreignId);

            if (!existingByForeignId.has(key)) {
                existingByForeignId.set(key, pivot);
            } else {
                duplicatePivots.push(pivot);
            }
        }

        for (const duplicate of duplicatePivots) {
            deletePivot(duplicate);
        }

        for (const [foreignId, pivot] of Array.from(existingByForeignId.entries())) {
            if (!desiredByForeignId.has(foreignId)) {
                deletePivot(pivot);
            }
        }

        const insertRecords: any[] = [];

        for (const [foreignId, desired] of Array.from(desiredByForeignId.entries())) {
            const existingPivot = existingByForeignId.get(foreignId);

            if (!existingPivot) {
                const pivotRecord: any = {
                    [localColMeta.columnName]: this.id,
                    [foreignColMeta.columnName]: foreignId,
                };

                for (const [pivotProp, pivotVal] of Object.entries(desired.pivotExtra)) {
                    const pivotColMeta = pivotColumns.find(c => c.propertyName === pivotProp);

                    if (!pivotColMeta) continue;
                    if (pivotColMeta.readOnly) continue;
                    if (pivotProp === rel.pivotLocalKey || pivotProp === rel.pivotForeignKey) continue;

                    pivotRecord[pivotColMeta.columnName] = Model._serializePivotValue(pivotVal, pivotColMeta);
                }

                insertRecords.push(pivotRecord);
                continue;
            }

            const updateData: any = {};

            for (const [pivotProp, pivotVal] of Object.entries(desired.pivotExtra)) {
                const pivotColMeta = pivotColumns.find(c => c.propertyName === pivotProp);

                if (!pivotColMeta) continue;
                if (pivotColMeta.readOnly) continue;
                if (pivotProp === rel.pivotLocalKey || pivotProp === rel.pivotForeignKey) continue;

                const currentVal = (existingPivot as any)[pivotProp];
                const nextVal = Model._serializePivotValue(pivotVal, pivotColMeta);
                const currentSerialized = Model._serializePivotValue(currentVal, pivotColMeta);

                if (!Model._pivotValuesEqual(currentSerialized, nextVal)) {
                    updateData[pivotColMeta.columnName] = nextVal;
                }
            }

            if (Object.keys(updateData).length > 0) {
                if (!existingPivot.id) {
                    throw new ORMValidationError({
                        [rel.propertyName]: "Existing pivot row has no id.",
                    });
                }

                obj.update(existingPivot.id, updateData);
            }
        }

        if (insertRecords.length > 0) {
            for (const chunk of _chunk(insertRecords, BATCH_CHUNK_SIZE)) {
                obj.batchInsert(chunk);
            }
        }
    }

    private static _ensureSchemaValidFor(ctor: typeof Model): void {
        const tableName = getTableName(ctor);
        const key = `${ctor.name}:${tableName ?? ""}`;

        if (Model.__schemaValidatedModels.has(key)) return;

        Model._validateSchemaFor(ctor);

        Model.__schemaValidatedModels.add(key);
    }

    private static _validateSchemaFor(ctor: typeof Model): void {
        const tableName = getTableName(ctor);

        if (!tableName) {
            throw new ORMValidationError({
                entity: `Entity '${ctor.name}' is missing @Entity decorator.`,
            });
        }

        const columns = ctor._columns();
        const relations = ctor._relations();

        const columnProps = new Set<string>();
        const columnNames = new Set<string>();

        for (const col of columns) {
            if (!col.propertyName) {
                throw new ORMValidationError({
                    schema: `Column in '${ctor.name}' is missing propertyName.`,
                });
            }

            if (!col.columnName) {
                throw new ORMValidationError({
                    schema: `Column '${col.propertyName}' in '${ctor.name}' is missing columnName.`,
                });
            }

            if (columnProps.has(col.propertyName)) {
                throw new ORMValidationError({
                    schema: `Duplicate column property '${col.propertyName}' in '${ctor.name}'.`,
                });
            }

            if (columnNames.has(col.columnName)) {
                throw new ORMValidationError({
                    schema: `Duplicate database column '${col.columnName}' in '${ctor.name}'.`,
                });
            }

            columnProps.add(col.propertyName);
            columnNames.add(col.columnName);
        }

        for (const rel of relations) {
            if (!rel.propertyName) {
                throw new ORMValidationError({
                    schema: `Relation in '${ctor.name}' is missing propertyName.`,
                });
            }

            if (!rel.type) {
                throw new ORMValidationError({
                    schema: `Relation '${rel.propertyName}' in '${ctor.name}' is missing type.`,
                });
            }

            if (!["ManyToOne", "OneToOne", "OneToMany", "ManyToMany"].includes(rel.type)) {
                throw new ORMValidationError({
                    schema: `Relation '${rel.propertyName}' in '${ctor.name}' has invalid type '${rel.type}'.`,
                });
            }

            const TargetClass = rel.target?.() as typeof Model;

            if (!TargetClass || typeof TargetClass._columns !== "function") {
                throw new ORMValidationError({
                    schema: `Relation '${rel.propertyName}' in '${ctor.name}' has invalid target model.`,
                });
            }

            if (!getTableName(TargetClass)) {
                throw new ORMValidationError({
                    schema: `Relation '${rel.propertyName}' in '${ctor.name}' target '${TargetClass.name}' is missing @Entity decorator.`,
                });
            }

            if (rel.type === "ManyToOne" || rel.type === "OneToOne" || rel.type === "OneToMany") {
                if (!rel.foreignKey) {
                    throw new ORMValidationError({
                        schema: `Relation '${rel.propertyName}' in '${ctor.name}' is missing foreignKey.`,
                    });
                }
            }

            if (rel.type === "ManyToOne" || rel.type === "OneToOne") {
                console.log("columnProps", columnProps)
                if (!columnProps.has(rel.foreignKey!)) {
                    throw new ORMValidationError({
                        schema: `Relation '${rel.propertyName}' in '${ctor.name}' uses missing foreignKey '${rel.foreignKey}'.`,
                    });
                }
            }

            if (rel.type === "OneToMany") {
                const targetCols = TargetClass._columns();
                const targetProps = new Set(targetCols.map(c => c.propertyName));

                if (!targetProps.has(rel.foreignKey!)) {
                    throw new ORMValidationError({
                        schema: `Relation '${rel.propertyName}' in '${ctor.name}' uses missing target foreignKey '${rel.foreignKey}' on '${TargetClass.name}'.`,
                    });
                }
            }

            if (rel.type === "ManyToMany") {
                if (!rel.pivotEntity || !rel.pivotLocalKey || !rel.pivotForeignKey) {
                    throw new ORMValidationError({
                        schema: `ManyToMany relation '${rel.propertyName}' in '${ctor.name}' needs pivotEntity, pivotLocalKey, and pivotForeignKey.`,
                    });
                }

                const PivotClass = rel.pivotEntity() as typeof Model;

                if (!PivotClass || typeof PivotClass._columns !== "function") {
                    throw new ORMValidationError({
                        schema: `ManyToMany relation '${rel.propertyName}' in '${ctor.name}' has invalid pivotEntity.`,
                    });
                }

                if (!getTableName(PivotClass)) {
                    throw new ORMValidationError({
                        schema: `ManyToMany relation '${rel.propertyName}' in '${ctor.name}' pivot entity '${PivotClass.name}' is missing @Entity decorator.`,
                    });
                }

                const pivotCols = PivotClass._columns();
                const pivotProps = new Set(pivotCols.map(c => c.propertyName));

                if (!pivotProps.has(rel.pivotLocalKey)) {
                    throw new ORMValidationError({
                        schema: `ManyToMany relation '${rel.propertyName}' in '${ctor.name}' uses missing pivotLocalKey '${rel.pivotLocalKey}' on '${PivotClass.name}'.`,
                    });
                }

                if (!pivotProps.has(rel.pivotForeignKey)) {
                    throw new ORMValidationError({
                        schema: `ManyToMany relation '${rel.propertyName}' in '${ctor.name}' uses missing pivotForeignKey '${rel.pivotForeignKey}' on '${PivotClass.name}'.`,
                    });
                }
            }
        }
    }

    static _deletedAtColumn(): ColumnMeta | undefined {
        return this._columns().find(c => c.system === "deletedAt" || c.propertyName === "deletedAt");
    }

    static _deletedByColumn(): ColumnMeta | undefined {
        return this._columns().find(c => c.system === "deletedBy" || c.propertyName === "deletedBy");
    }

    static _buildCondition(where: Record<string, any>): db.Condition {
        const columns = this._columns();
        const colMap: Record<string, string> = {};
        const typeMap: Record<string, string> = {};

        for (const col of columns) {
            colMap[col.propertyName] = col.columnName;
            if (col.type) typeMap[col.propertyName] = col.type;
        }

        const LOGIC_KEYS = new Set(["OR", "AND", "NOT"]);

        const toFieldCondition = (key: string, value: any): db.ConditionOperator | null => {
            if (value === undefined) return null;

            const col = colMap[key] ?? SYSTEM_FIELD_MAP[key] ?? key;

            if (value === null) return { field: col, operator: "isnull" };

            if (typeof value === "object" && !Array.isArray(value) && (value as QueryOperator)._isOperator) {
                const op = value as QueryOperator;
                const colType = typeMap[key];

                if (op.op === "in" && Array.isArray(op.val) && op.val.length === 0) return null;

                if ((op.op === "contains" || op.op === "endwith")) {
                    console.warn(
                        `[ORM Warning] Op.${op.op === "contains" ? "Contains" : "EndsWith"} on field "${key}" causes a full table scan.`
                    );
                }

                if (colType) {
                    const allowed = TYPE_OP_MAP[colType];
                    if (allowed && op.op && !allowed.includes(op.op)) {
                        console.warn(`[ORM Warning] Operator "${op.op}" is not valid for type "${colType}" on field "${key}".`);
                    }
                }

                if (op.val !== undefined) {
                    if (op.op === "ne" && op.val === null) return { field: col, operator: "isnotnull" };
                    if (op.op === "eq" && op.val === null) return { field: col, operator: "isnull" };
                    return { field: col, operator: op.op, value: op.val };
                }

                return { field: col, operator: op.op };
            }

            if (Array.isArray(value)) {
                if (value.length === 0) return null;
                return { field: col, operator: "in", value };
            }

            return { field: col, operator: "eq", value };
        };

        const buildNode = (node: any): db.Condition => {
            const out: db.Conditions[] = [];

            if (!node || typeof node !== "object") {
                return { conjunction: db.Conjunction.AND, conditions: out };
            }

            // plain fields
            for (const [key, value] of Object.entries(node)) {
                if (LOGIC_KEYS.has(key)) continue;
                const leaf = toFieldCondition(key, value);
                if (leaf) out.push(leaf);
            }

            // OR
            if (Array.isArray(node.OR) && node.OR.length > 0) {
                const orChildren: db.Conditions[] = [];

                for (const child of node.OR) {
                    const childCond = buildNode(child);
                    if (childCond.conditions && childCond.conditions.length > 0) {
                        orChildren.push({ condition: childCond }); // <-- required wrapper
                    }
                }

                if (orChildren.length > 0) {
                    out.push({
                        condition: {
                            conjunction: db.Conjunction.OR,
                            conditions: orChildren,
                        },
                    });
                }
            }

            // AND
            if (Array.isArray(node.AND) && node.AND.length > 0) {
                const andChildren: db.Conditions[] = [];

                for (const child of node.AND) {
                    const childCond = buildNode(child);
                    if (childCond.conditions && childCond.conditions.length > 0) {
                        andChildren.push({ condition: childCond }); // <-- required wrapper
                    }
                }

                if (andChildren.length > 0) {
                    out.push({
                        condition: {
                            conjunction: db.Conjunction.AND,
                            conditions: andChildren,
                        },
                    });
                }
            }

            // NOT not supported by enum; emulate with inverse for simple leaves only (optional)
            if (node.NOT && typeof node.NOT === "object") {
                for (const [k, v] of Object.entries(node.NOT)) {
                    if (LOGIC_KEYS.has(k)) continue;
                    const col = colMap[k] ?? SYSTEM_FIELD_MAP[k] ?? k;

                    if (v === null) out.push({ field: col, operator: "isnotnull" });
                    else if (typeof v === "object" && !Array.isArray(v) && (v as QueryOperator)._isOperator) {
                        const op = v as QueryOperator;
                        if (op.op === "eq") out.push({ field: col, operator: "ne", value: op.val });
                        else if (op.op === "ne") out.push({ field: col, operator: "eq", value: op.val });
                        else if (op.op === "isnull") out.push({ field: col, operator: "isnotnull" });
                        else if (op.op === "isnotnull") out.push({ field: col, operator: "isnull" });
                    } else {
                        out.push({ field: col, operator: "ne", value: v });
                    }
                }
            }

            return { conjunction: db.Conjunction.AND, conditions: out };
        };

        return buildNode(where);
    }

    static _applySoftDeleteWhere<T extends Model>(
        this: ModelClass<T>,
        where?: Record<string, any>,
        options?: { withSoftDeleted?: boolean; onlySoftDeleted?: boolean }
    ): Record<string, any> {
        const deletedAt = this._deletedAtColumn();
        const next: Record<string, any> = { ...(where ?? {}) };

        if (!deletedAt) return next;

        const hasDeletedAtFilter =
            Object.prototype.hasOwnProperty.call(next, deletedAt.propertyName) ||
            Object.prototype.hasOwnProperty.call(next, deletedAt.columnName);

        if (options?.onlySoftDeleted) {
            next[deletedAt.propertyName] = { _isOperator: true, op: "isnotnull" };
            return next;
        }

        if (options?.withSoftDeleted) return next;

        if (!hasDeletedAtFilter) {
            next[deletedAt.propertyName] = null;
        }

        return next;
    }

    static _rawPassesSoftDelete<T extends Model>(
        this: ModelClass<T>,
        raw: any,
        options?: { withSoftDeleted?: boolean; onlySoftDeleted?: boolean }
    ): boolean {
        const deletedAt = this._deletedAtColumn();

        if (!deletedAt) return true;

        const val = raw?.[deletedAt.columnName];

        if (options?.withSoftDeleted) return true;
        if (options?.onlySoftDeleted) return val !== null && val !== undefined && val !== "";

        return val === null || val === undefined || val === "";
    }

    static mapFromDb<T extends Model>(
        this: ModelClass<T>,
        raw: any,
        select?: string[]
    ): T {
        const instance = new this();
        const self = instance as any;
        const columns = this._columns();

        self.__isNew = false;
        self.__dirtyFields = new Set();
        self.__relationDirty = new Set();
        self.__originalValues = new Map();
        self.id = raw.id;
        self.createdAt = toDateOrNull(raw.createdDate) ?? undefined;

        self.__selectedFields = select && select.length > 0
            ? new Set(select)
            : undefined;

        for (const col of columns) {
            if (select && select.length > 0 && !select.includes(col.propertyName)) continue;

            let val = raw[col.columnName];

            if (val === undefined) continue;

            if (col.type === "picklistMulti") {
                if (typeof val === "string") {
                    val = val.trim() === "" ? [] : val.split(";").filter((v: string) => v !== "");
                } else if (val === null || val === undefined) {
                    val = [];
                }
            }

            if (col.type === "multiLanguage") {
                self.__originalValues.set(col.propertyName, val);
            }

            if ((col.type === "date" || col.type === "datetime") && typeof val === "string" && val !== "") {
                val = new Date(val);
            }

            if (
                (col.type === "number" || col.type === "currency" || col.type === "percent") &&
                val !== null &&
                val !== undefined
            ) {
                val = Number(val);
            }

            Object.defineProperty(instance, col.propertyName, {
                value: val,
                writable: true,
                enumerable: true,
                configurable: true,
            });
        }

        return instance;
    }

    static _resolveMLFields<T extends Model>(
        this: ModelClass<T>,
        instances: T[],
        select?: string[]
    ): void {
        if (instances.length === 0) return;

        const mlCols = this._columns().filter(
            c => c.type === "multiLanguage" && (!select || select.includes(c.propertyName))
        );

        for (const col of mlCols) {
            const ids = instances
                .map(i => (i as any).__originalValues?.get(col.propertyName))
                .filter((id): id is string => !!id);

            if (ids.length === 0) continue;

            const resolved = MLHelper.resolveAllBatch(ids);

            for (const instance of instances) {
                const rid = (instance as any).__originalValues?.get(col.propertyName);
                if (!rid) continue;

                Object.defineProperty(instance, col.propertyName, {
                    value: resolved.get(rid) ?? {},
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });
            }
        }
    }

    toJSON(): Record<string, any> {
        const columns = this._getColumns();
        const relations = this._getRelations();
        const self = this as any;

        const result: Record<string, any> = {
            id: this.id,
            createdAt: this.createdAt,
        };

        for (const col of columns) {
            result[col.propertyName] = self[col.propertyName];
        }

        for (const rel of relations) {
            const val = self[rel.propertyName];

            if (val === undefined) continue;

            if (Array.isArray(val)) {
                result[rel.propertyName] = val.map((item: any) =>
                    item && typeof item.toJSON === "function" ? item.toJSON() : item
                );
            } else if (val && typeof val.toJSON === "function") {
                result[rel.propertyName] = val.toJSON();
            } else {
                result[rel.propertyName] = val;
            }
        }

        if (this.__pivot && Object.keys(this.__pivot).length > 0) {
            result.pivot = this.__pivot;
        }

        return result;
    }

    isDirty(field?: string): boolean {
        if (field) return this.__dirtyFields.has(field);
        return this.__dirtyFields.size > 0 || this.__relationDirty.size > 0;
    }

    isNew(): boolean {
        return this.__isNew;
    }

    getDirtyFields(): string[] {
        return Array.from(this.__dirtyFields);
    }

    getDirtyRelations(): string[] {
        return Array.from(this.__relationDirty);
    }

    withPivot(data: Record<string, any>): this {
        this.__pivot = data;
        return this;
    }

    getPivot<T extends Record<string, any> = Record<string, any>>(): T | undefined {
        return this.__pivot as T | undefined;
    }

    reload(): this {
        if (!this.id) {
            throw new ORMValidationError({ id: "Cannot reload: record has no id" });
        }

        const ctor = this.constructor as typeof Model;
        Model._ensureSchemaValidFor(ctor);

        const tableName = ctor._tableName();
        const columns = this._getColumns();
        const self = this as any;

        const raw = db.dynamicObject(tableName).query(this.id);

        if (!raw) throw new ORMNotFoundError(ctor.name, this.id);

        self.createdAt = toDateOrNull(raw.createdDate) ?? undefined;
        self.__originalValues = new Map();

        for (const col of columns) {
            let val = raw[col.columnName];

            if (val === undefined) continue;

            if ((col.type === "date" || col.type === "datetime") && typeof val === "string" && val !== "") {
                val = new Date(val);
            }

            if (
                (col.type === "number" || col.type === "currency" || col.type === "percent") &&
                val !== null &&
                val !== undefined
            ) {
                val = Number(val);
            }

            if (col.type === "picklistMulti") {
                if (typeof val === "string") {
                    val = val.trim() === "" ? [] : val.split(";").filter((v: string) => v !== "");
                } else if (val === null || val === undefined) {
                    val = [];
                }
            }

            if (col.type === "multiLanguage") {
                self.__originalValues.set(col.propertyName, val);

                Object.defineProperty(this, col.propertyName, {
                    value: MLHelper.resolveAll(val as string),
                    writable: true,
                    enumerable: true,
                    configurable: true,
                });

                continue;
            }

            Object.defineProperty(this, col.propertyName, {
                value: val,
                writable: true,
                enumerable: true,
                configurable: true,
            });
        }

        self.__dirtyFields = new Set();
        self.__relationDirty = new Set();
        self.__isNew = false;
        self.__selectedFields = undefined;

        return this;
    }

    private _validate(): void {
        const columns = this._getColumns();
        const relations = this._getRelations();
        const self = this as any;

        for (const col of columns) {
            const value = self[col.propertyName];

            if (col.required) {
                const trimmedVal = typeof value === "string" ? value.trim() : value;

                if (trimmedVal === null || trimmedVal === undefined || trimmedVal === "") {
                    throw new ORMRequiredFieldError(col.propertyName);
                }

                if (col.type === "multiLanguage") {
                    const ml = value as MLValue;

                    if (!ml || !ml.en_US || ml.en_US.trim() === "") {
                        throw new ORMValidationError({
                            [col.propertyName]: "Must have a non-empty en_US value.",
                        });
                    }
                }
            }

            if (value === null || value === undefined) continue;

            if (col.minLength !== undefined && typeof value === "string" && value.length < col.minLength) {
                throw new ORMValidationError({ [col.propertyName]: `Must be at least ${col.minLength} characters.` });
            }

            if (col.maxLength !== undefined && typeof value === "string" && value.length > col.maxLength) {
                throw new ORMValidationError({ [col.propertyName]: `Must be at most ${col.maxLength} characters.` });
            }

            if (col.min !== undefined && typeof value === "number" && value < col.min) {
                throw new ORMValidationError({ [col.propertyName]: `Must be at least ${col.min}.` });
            }

            if (col.max !== undefined && typeof value === "number" && value > col.max) {
                throw new ORMValidationError({ [col.propertyName]: `Must be at most ${col.max}.` });
            }

            if (col.type) {
                switch (col.type) {
                    case "text":
                        if (!col.maxLength && typeof value === "string" && value.length > 255) {
                            throw new ORMValidationError({ [col.propertyName]: "Must be at most 255 characters." });
                        }
                        break;

                    case "encryptedText":
                        if (!col.maxLength && typeof value === "string" && value.length > 111) {
                            throw new ORMValidationError({ [col.propertyName]: "Must be at most 111 characters." });
                        }
                        break;

                    case "textArea":
                        if (!col.maxLength && typeof value === "string" && value.length > 1048576) {
                            throw new ORMValidationError({ [col.propertyName]: "Must be at most 1,048,576 characters." });
                        }
                        break;

                    case "number":
                    case "currency":
                        if (typeof value !== "number") {
                            throw new ORMValidationError({ [col.propertyName]: "Must be a number." });
                        }
                        break;

                    case "percent":
                        if (typeof value !== "number" || value < 0 || value > 100) {
                            throw new ORMValidationError({ [col.propertyName]: "Must be between 0 and 100." });
                        }
                        break;

                    case "checkbox":
                        if (typeof value !== "boolean") {
                            throw new ORMValidationError({ [col.propertyName]: "Must be a boolean." });
                        }
                        break;

                    case "email":
                        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) {
                            throw new ORMValidationError({ [col.propertyName]: "Must be a valid email address." });
                        }
                        break;

                    case "url":
                        if (!/^https?:\/\/.+/.test(String(value))) {
                            throw new ORMValidationError({
                                [col.propertyName]: "Must be a valid URL starting with http:// or https://.",
                            });
                        }
                        break;

                    case "phone":
                        if (!/^\+?[\d\s\-().]{7,20}$/.test(String(value))) {
                            throw new ORMValidationError({ [col.propertyName]: "Must be a valid phone number." });
                        }
                        break;

                    case "date":
                        if (!(value instanceof Date) && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
                            throw new ORMValidationError({ [col.propertyName]: "Must be in format YYYY-MM-DD." });
                        }
                        break;

                    case "datetime":
                        if (!(value instanceof Date) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(value))) {
                            throw new ORMValidationError({ [col.propertyName]: "Must be a valid ISO 8601 datetime." });
                        }
                        break;

                    case "picklist":
                        if (col.allowedValues && !col.allowedValues.includes(String(value))) {
                            throw new ORMValidationError({
                                [col.propertyName]: `Must be one of: ${col.allowedValues.join(", ")}.`,
                            });
                        }
                        break;

                    case "picklistMulti":
                        if (!Array.isArray(value)) {
                            throw new ORMValidationError({ [col.propertyName]: "Must be an array." });
                        }

                        if (col.allowedValues) {
                            for (const v of value as any[]) {
                                if (!col.allowedValues.includes(String(v))) {
                                    throw new ORMValidationError({
                                        [col.propertyName]: `Contains invalid value "${v}". Allowed: ${col.allowedValues.join(", ")}.`,
                                    });
                                }
                            }
                        }
                        break;

                    case "multiLanguage":
                        if (typeof value !== "object" || Array.isArray(value)) {
                            throw new ORMValidationError({ [col.propertyName]: "Must be an MLValue object." });
                        }
                        break;
                }
            }

            if (col.validate) col.validate(value);
        }

        for (const rel of relations) {
            if (rel.cascadeType !== "master") continue;
            if (rel.type !== "ManyToOne" && rel.type !== "OneToOne") continue;
            if (!rel.foreignKey) continue;

            const fkValue = self[rel.foreignKey];

            if (!fkValue) {
                throw new ORMValidationError({
                    [rel.foreignKey]: `This field is required because ${rel.propertyName} is a master relation.`,
                });
            }
        }
    }

    private _buildInsertRecord(columns: ColumnMeta[]): any {
        const self = this as any;
        const record: any = {};

        for (const col of columns) {
            if (col.readOnly) continue;

            let val = self[col.propertyName];

            if (val === undefined) continue;

            if (col.type === "date" && val !== null) {
                val = toDateOnlyString(val);
            }

            if (col.type === "datetime" && val !== null) {
                val = toUtcISOString(val);
            }

            if (col.type === "picklistMulti" && Array.isArray(val)) {
                val = val.join(";");
            }

            if (col.type === "multiLanguage") {
                const resourceId = MLHelper.create(val as MLValue, col);
                self.__originalValues?.set(col.propertyName, resourceId);
                val = resourceId;
            }

            record[col.columnName] = val;
        }

        return record;
    }

    private _serializeUpdateValue(field: string, colMeta: ColumnMeta | undefined): any {
        const self = this as any;
        let val = self[field];

        if (colMeta?.type === "date" && val !== null && val !== undefined) {
            val = toDateOnlyString(val);
        }

        if (colMeta?.type === "datetime" && val !== null && val !== undefined) {
            val = toUtcISOString(val);
        }

        if (colMeta?.type === "picklistMulti" && Array.isArray(val)) {
            val = val.join(";");
        }

        return val;
    }

    save(options?: SaveOptions<this>, _isRetry = false): void {
        const ctor = this.constructor as typeof Model;
        Model._ensureSchemaValidFor(ctor);

        const tableName = ctor._tableName();
        const self = this as any;
        const relations = this._getRelations();
        const columns = this._getColumns();
        const spec = options?.relations as Record<string, any> | undefined;

        const colMap: Record<string, string> = {};
        for (const col of columns) colMap[col.propertyName] = col.columnName;

        try {
            for (const rel of relations) {
                if (rel.type !== "ManyToOne" && rel.type !== "OneToOne") continue;

                const isDirty = this.__relationDirty.has(rel.propertyName);
                const specNode = spec?.[rel.propertyName];

                if (!isDirty && !specNode) continue;

                const value = self[rel.propertyName];
                if (!value) continue;

                const childSpec = specNode === true || !specNode ? undefined : specNode.relations;
                const item = value as Model;

                if (!item.id || item.__dirtyFields.size > 0 || item.__relationDirty.size > 0) {
                    item.save(childSpec ? { relations: childSpec } : undefined);
                }

                if (rel.foreignKey) {
                    self[rel.foreignKey] = item.id;
                    this.__dirtyFields.add(rel.foreignKey);
                }

                this.__relationDirty.delete(rel.propertyName);
            }

            this._validate();

            if (this.__isNew) {
                const record = this._buildInsertRecord(columns);

                const newId = db.dynamicObject(tableName).insert(record);

                self.id = newId;
                self.__isNew = false;
                self.__dirtyFields = new Set();
            } else if (this.__dirtyFields.size > 0) {
                const dbData: any = {};

                for (const field of Array.from(this.__dirtyFields)) {
                    const colMeta = columns.find(c => c.propertyName === field);

                    if (colMeta?.readOnly) continue;

                    if (colMeta?.type === "multiLanguage") {
                        const oldResourceId = self.__originalValues?.get(field) as string | undefined;
                        const oldResolved = oldResourceId ? MLHelper.resolveAll(oldResourceId) : undefined;

                        MLHelper.update(oldResourceId ?? "", oldResolved, self[field] as MLValue, colMeta);
                        continue;
                    }

                    const colName = colMap[field] ?? SYSTEM_FIELD_MAP[field];

                    if (colName) dbData[colName] = this._serializeUpdateValue(field, colMeta);
                }

                if (Object.keys(dbData).length > 0) {
                    db.dynamicObject(tableName).update(this.id!, dbData);
                }

                self.__dirtyFields = new Set();
            }

            this._saveRelationTree(spec);
            self.__relationDirty = new Set();
        } catch (err: any) {
            const retry = (): void => this.save(options, true);

            const result = _handleCaughtError(
                err,
                retry,
                !_isRetry,
                () => (ctor as typeof Model).handleDbError(err, this)
            );

            return result as void;
        }
    }

    private _saveRelationTree(spec?: Record<string, any>): void {
        const relations = this._getRelations();
        const self = this as any;

        for (const rel of relations) {
            const isDirty = this.__relationDirty.has(rel.propertyName);
            const specNode = spec?.[rel.propertyName];

            if (!isDirty && !specNode) continue;

            const value = self[rel.propertyName];

            if (value === undefined || value === null) continue;

            const childSpec = specNode === true || specNode === undefined ? undefined : specNode.relations;

            switch (rel.type) {
                case "ManyToOne":
                case "OneToOne": {
                    const item = value as Model;

                    if (!item.id || item.__dirtyFields.size > 0 || item.__relationDirty.size > 0) {
                        item.save(childSpec ? { relations: childSpec } : undefined);
                    }

                    break;
                }

                case "OneToMany": {
                    const items = (value as Model[]) ?? [];

                    for (const item of items) {
                        if (rel.foreignKey) {
                            (item as any)[rel.foreignKey] = this.id;
                            item.__dirtyFields.add(rel.foreignKey);
                        }

                        item.save(childSpec ? { relations: childSpec } : undefined);
                    }

                    break;
                }

                case "ManyToMany": {
                    this._syncManyToManyRelation(rel, value, childSpec);
                    break;
                }
            }
        }
    }

    delete(options?: DeleteOptions<this>, _isRetry = false): void {
        if (this._hasSoftDelete()) return this._softDelete(options, _isRetry);
        return this._hardDelete(options, _isRetry);
    }

    forceDelete(options?: DeleteOptions<this>, _isRetry = false): void {
        return this._hardDelete(options, _isRetry);
    }

    private _softDelete(options?: DeleteOptions<this>, _isRetry = false): void {
        if (!this.id) throw new ORMValidationError({ id: "Cannot delete: record has no id" });

        const ctor = this.constructor as typeof Model;
        Model._ensureSchemaValidFor(ctor);

        const tableName = ctor._tableName();
        const deletedAtCol = ctor._deletedAtColumn();
        const deletedByCol = ctor._deletedByColumn();

        if (!deletedAtCol) return this._hardDelete(options, _isRetry);

        try {
            this._cascadeDelete(options, false);

            const self = this as any;
            const now = new Date();
            const dbData: any = {
                [deletedAtCol.columnName]: now.toISOString(),
            };

            self[deletedAtCol.propertyName] = now;

            if (deletedByCol) {
                const userId = getUserId();

                dbData[deletedByCol.columnName] = userId;
                self[deletedByCol.propertyName] = userId;
            }

            db.dynamicObject(tableName).update(this.id, dbData);

            self.__dirtyFields = new Set();
            self.__relationDirty = new Set();
        } catch (err: any) {
            const retry = (): void => this._softDelete(options, true);

            const result = _handleCaughtError(
                err,
                retry,
                !_isRetry,
                () => ctor.handleDbError(err, this)
            );

            return result as void;
        }
    }

    private _hardDelete(options?: DeleteOptions<this>, _isRetry = false): void {
        if (!this.id) throw new ORMValidationError({ id: "Cannot delete: record has no id" });

        const ctor = this.constructor as typeof Model;
        Model._ensureSchemaValidFor(ctor);

        const tableName = ctor._tableName();
        const columns = this._getColumns();
        const self = this as any;

        try {
            const mlCols = columns.filter(c => c.type === "multiLanguage");

            if (mlCols.length > 0) {
                const raw = db.dynamicObject(tableName).query(this.id);

                if (raw) {
                    for (const col of mlCols) {
                        const resourceId = raw[col.columnName];

                        if (resourceId) MLHelper.delete(resourceId);
                    }
                }
            }

            this._cascadeDelete(options, true);
            db.dynamicObject(tableName).delete(this.id);

            self.id = undefined;
            self.__isNew = true;
        } catch (err: any) {
            const retry = (): void => this._hardDelete(options, true);

            const result = _handleCaughtError(
                err,
                retry,
                !_isRetry,
                () => ctor.handleDbError(err, this)
            );

            return result as void;
        }
    }

    private _cascadeDelete(options?: DeleteOptions<this>, force = false): void {
        const relations = this._getRelations();
        const self = this as any;

        const runRelation = (rel: RelationMeta): void => {
            const TargetClass = rel.target() as ModelClass<Model>;

            if (rel.type === "OneToMany") {
                if (!rel.foreignKey || !this.id) return;

                const children = TargetClass.find({
                    where: { [rel.foreignKey]: this.id } as any,
                    withSoftDeleted: force,
                    limit: 5000,
                }) as Model[];

                for (const child of children) {
                    if (force) child.forceDelete();
                    else child.delete();
                }

                return;
            }

            if (rel.type === "OneToOne") {
                if (!rel.foreignKey) return;

                const fkValue = self[rel.foreignKey];

                if (!fkValue) return;

                const related = TargetClass.findOne(fkValue, { withSoftDeleted: force }) as Model | null;

                if (!related) return;

                if (force) related.forceDelete();
                else related.delete();

                return;
            }

            if (rel.type === "ManyToMany") {
                if (!rel.pivotEntity || !rel.pivotLocalKey) return;

                const PivotClass = rel.pivotEntity() as ModelClass<Model>;
                const pivotColumns = PivotClass._columns();
                const localColMeta = pivotColumns.find(c => c.propertyName === rel.pivotLocalKey);

                if (!localColMeta) return;

                const condition = {
                    conjunction: db.Conjunction.AND,
                    conditions: [{ field: localColMeta.columnName, operator: "eq", value: this.id }],
                };

                if (!force && PivotClass._deletedAtColumn()) {
                    const pivots = PivotClass.find({
                        where: { [rel.pivotLocalKey]: this.id } as any,
                        limit: 5000,
                    }) as Model[];

                    for (const pivot of pivots) {
                        pivot.delete();
                    }

                    return;
                }

                db.dynamicObject(PivotClass._tableName()).deleteByCondition(condition);
            }
        };

        for (const rel of relations) {
            if (rel.cascadeType === "master") runRelation(rel);
        }

        if (options?.relations) {
            const spec = options.relations as Record<string, any>;

            for (const rel of relations) {
                if (rel.cascadeType === "master") continue;
                if (spec[rel.propertyName]) runRelation(rel);
            }
        }
    }

    restore(options?: RestoreOptions<this>, _isRetry = false): void {
        if (!this.id) throw new ORMValidationError({ id: "Cannot restore: record has no id" });

        const ctor = this.constructor as typeof Model;
        Model._ensureSchemaValidFor(ctor);

        const tableName = ctor._tableName();
        const deletedAtCol = ctor._deletedAtColumn();
        const deletedByCol = ctor._deletedByColumn();

        if (!deletedAtCol) {
            throw new ORMValidationError({ deletedAt: "Cannot restore: model does not have @DeletedAt()." });
        }

        try {
            const self = this as any;
            const dbData: any = {
                [deletedAtCol.columnName]: null,
            };

            self[deletedAtCol.propertyName] = null;

            if (deletedByCol) {
                dbData[deletedByCol.columnName] = null;
                self[deletedByCol.propertyName] = null;
            }

            db.dynamicObject(tableName).update(this.id, dbData);

            self.__dirtyFields = new Set();
            self.__relationDirty = new Set();

            this._cascadeRestore(options);
        } catch (err: any) {
            const retry = (): void => this.restore(options, true);

            const result = _handleCaughtError(
                err,
                retry,
                !_isRetry,
                () => ctor.handleDbError(err, this)
            );

            return result as void;
        }
    }

    private _cascadeRestore(options?: RestoreOptions<this>): void {
        const relations = this._getRelations();
        const self = this as any;

        const runRelation = (rel: RelationMeta): void => {
            const TargetClass = rel.target() as ModelClass<Model>;

            if (!TargetClass._deletedAtColumn()) return;

            if (rel.type === "OneToMany") {
                if (!rel.foreignKey || !this.id) return;

                const children = TargetClass.find({
                    where: { [rel.foreignKey]: this.id } as any,
                    onlySoftDeleted: true,
                    limit: 5000,
                }) as Model[];

                for (const child of children) child.restore();

                return;
            }

            if (rel.type === "OneToOne") {
                if (!rel.foreignKey) return;

                const fkValue = self[rel.foreignKey];

                if (!fkValue) return;

                const related = TargetClass.findOne(fkValue, { withSoftDeleted: true }) as Model | null;

                if (related && (related as any).deletedAt) related.restore();

                return;
            }

            if (rel.type === "ManyToMany") {
                if (!rel.pivotEntity || !rel.pivotLocalKey) return;

                const PivotClass = rel.pivotEntity() as ModelClass<Model>;

                if (!PivotClass._deletedAtColumn()) return;

                const pivots = PivotClass.find({
                    where: { [rel.pivotLocalKey]: this.id } as any,
                    onlySoftDeleted: true,
                    limit: 5000,
                }) as Model[];

                for (const pivot of pivots) pivot.restore();
            }
        };

        for (const rel of relations) {
            if (rel.cascadeType === "master") runRelation(rel);
        }

        if (options?.relations) {
            const spec = options.relations as Record<string, any>;

            for (const rel of relations) {
                if (rel.cascadeType === "master") continue;
                if (spec[rel.propertyName]) runRelation(rel);
            }
        }
    }

    private static _normalizeRelationNode(
        node: RelationNode<any> | true | undefined
    ): {
        where?: Record<string, any> | undefined;
        pivotWhere?: Record<string, any> | undefined;
        relations?: RelationSpec<any> | undefined;
        select?: string[] | undefined;
        orderBy?: any[] | undefined;
        limit?: number | undefined;
        withSoftDeleted?: boolean | undefined;
        onlySoftDeleted?: boolean | undefined;
    } {
        if (!node || node === true) return {};

        return {
            where: node.where as any,
            pivotWhere: node.pivotWhere,
            relations: node.relations as any,
            select: node.select as string[] | undefined,
            orderBy: node.orderBy as any[] | undefined,
            limit: node.limit,
            withSoftDeleted: node.withSoftDeleted,
            onlySoftDeleted: node.onlySoftDeleted,
        };
    }

    private static _ensureSelect(
        select: string[] | undefined,
        requiredFields: string[]
    ): string[] | undefined {
        if (!select || select.length === 0) return undefined;

        const next = [...select];

        for (const field of requiredFields) {
            if (!next.includes(field)) next.push(field);
        }

        return next;
    }

    private static _uniqueStrings(values: any[]): string[] {
        const result: string[] = [];
        const seen = new Set<string>();

        for (const value of values) {
            if (value === null || value === undefined || value === "") continue;

            const str = String(value);

            if (!seen.has(str)) {
                seen.add(str);
                result.push(str);
            }
        }

        return result;
    }

    private static _buildOrderByOptions<T extends Model>(
        TargetClass: ModelClass<T>,
        orderBy?: any[]
    ): any[] {
        const columns = TargetClass._columns();
        const colMap: Record<string, string> = {};

        for (const col of columns) {
            colMap[col.propertyName] = col.columnName;
        }

        const finalOrderBy = orderBy && orderBy.length > 0
            ? orderBy
            : [{ field: "createdAt", order: "DESC" }];

        return finalOrderBy.map(ob => ({
            field: colMap[String(ob.field)] ?? SYSTEM_FIELD_MAP[String(ob.field)] ?? String(ob.field),
            order: ob.order,
        }));
    }

    private static _queryAllRaw<T extends Model>(
        TargetClass: ModelClass<T>,
        where: Record<string, any>,
        options?: {
            orderBy?: any[] | undefined;
            withSoftDeleted?: boolean | undefined;
            onlySoftDeleted?: boolean | undefined;
            relationName?: string | undefined;
        }
    ): any[] {
        if (_hasEmptyIn(where)) return [];

        const obj = db.dynamicObject(TargetClass._tableName());
        const softDeleteOptions = options
            ? {
                ...(options.withSoftDeleted !== undefined
                    ? { withSoftDeleted: options.withSoftDeleted }
                    : {}),
                ...(options.onlySoftDeleted !== undefined
                    ? { onlySoftDeleted: options.onlySoftDeleted }
                    : {}),
            }
            : undefined;
        const finalWhere = TargetClass._applySoftDeleteWhere(where, softDeleteOptions);
        const cond = TargetClass._buildCondition(finalWhere);
        const result: any[] = [];

        let skip = 0;

        while (true) {
            const queryOptions: any = {
                limit: RELATION_PAGE_SIZE,
                skip,
                orderby: Model._buildOrderByOptions(TargetClass, options?.orderBy),
            };

            const page = cond.conditions.length > 0
                ? obj.queryByCondition(cond, { options: queryOptions })
                : obj.queryByCondition({}, { options: queryOptions });

            if (!page || page.length === 0) break;

            result.push(...page);

            if (result.length > RELATION_MAX_ROWS) {
                throw new ORMError(
                    "RelationLoadError",
                    `Relation "${options?.relationName ?? TargetClass.name}" loaded more than ${RELATION_MAX_ROWS} rows. Add where, limit, or stricter filters.`,
                    400
                );
            }

            if (page.length < RELATION_PAGE_SIZE) break;

            skip += RELATION_PAGE_SIZE;
        }

        return result;
    }

    private static _mapRawList<T extends Model>(
        TargetClass: ModelClass<T>,
        raws: any[],
        select?: string[]
    ): T[] {
        const rows = raws.map((raw: any) => TargetClass.mapFromDb(raw, select));

        TargetClass._resolveMLFields(rows, select);

        return rows;
    }

    private static _sortModelsInMemory<T extends Model>(
        rows: T[],
        orderBy?: any[]
    ): T[] {
        if (!orderBy || orderBy.length === 0) return rows;

        return rows.slice().sort((a: any, b: any) => {
            for (const ob of orderBy) {
                const field = String(ob.field);
                const dir = ob.order === "ASC" ? 1 : -1;

                let av = a[field];
                let bv = b[field];

                if (av instanceof Date) av = av.getTime();
                if (bv instanceof Date) bv = bv.getTime();

                if (av === bv) continue;
                if (av === undefined || av === null) return 1;
                if (bv === undefined || bv === null) return -1;

                return av > bv ? dir : -dir;
            }

            return 0;
        });
    }

    private static _relationOrderBy(node: {
        orderBy?: any[] | undefined;
        limit?: number | undefined;
    }): any[] | undefined {
        if (node.orderBy && node.orderBy.length > 0) return node.orderBy;

        if (node.limit !== undefined && node.limit > 0) {
            return [{ field: "createdAt", order: "DESC" }];
        }

        return undefined;
    }

    private static _applyRelationLimit<T extends Model>(
        rows: T[],
        node: { limit?: number | undefined }
    ): T[] {
        if (node.limit === undefined) return rows;
        if (node.limit <= 0) return [];

        return rows.slice(0, node.limit);
    }

    private static _assignLoadedRelation(
        parent: Model,
        propertyName: string,
        value: any
    ): void {
        Object.defineProperty(parent, propertyName, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }

    private static _clearLoadState(rows: Model[]): void {
        for (const row of rows) {
            const self = row as any;

            self.__dirtyFields = new Set();
            self.__relationDirty = new Set();
        }
    }

    private static _batchLoadRelations<T extends Model>(
        this: ModelClass<T>,
        rows: T[],
        spec: RelationSpec<T>
    ): void {
        if (!rows || rows.length === 0 || !spec) return;

        const relations = this._relations();

        for (const rel of relations) {
            const rawNode = (spec as any)[rel.propertyName] as RelationNode<any> | true | undefined;

            if (!rawNode) continue;

            const node = Model._normalizeRelationNode(rawNode);

            Model._batchLoadOneRelation(rows, rel, node);

            if (rawNode !== true && node.relations) {
                const children: Model[] = [];
                const seen = new Set<Model>();

                for (const row of rows) {
                    const loaded = (row as any)[rel.propertyName];

                    if (!loaded) continue;

                    const items = Array.isArray(loaded) ? loaded : [loaded];

                    for (const item of items) {
                        if (item && item instanceof Model && !seen.has(item)) {
                            seen.add(item);
                            children.push(item);
                        }
                    }
                }

                if (children.length > 0) {
                    const TargetClass = rel.target() as ModelClass<Model>;
                    Model._warmModelCache(TargetClass);
                    TargetClass._batchLoadRelations(children, node.relations as any);
                }
            }
        }

        Model._clearLoadState(rows);
    }

    private static _batchLoadOneRelation<T extends Model>(
        parents: T[],
        rel: RelationMeta,
        node: {
            where?: Record<string, any> | undefined;
            pivotWhere?: Record<string, any> | undefined;
            relations?: RelationSpec<any> | undefined;
            select?: string[] | undefined;
            orderBy?: any[] | undefined;
            limit?: number | undefined;
            withSoftDeleted?: boolean | undefined;
            onlySoftDeleted?: boolean | undefined;
        }
    ): void {
        const TargetClass = rel.target() as ModelClass<Model>;
        Model._warmModelCache(TargetClass);
        const orderBy = Model._relationOrderBy(node);

        switch (rel.type) {
            case "ManyToOne":
            case "OneToOne": {
                if (!rel.foreignKey) return;

                const fkValues = Model._uniqueStrings(
                    parents.map(parent => (parent as any)[rel.foreignKey!])
                );

                const targetById = new Map<string, Model>();

                for (const chunk of _chunk(fkValues, RELATION_ID_CHUNK_SIZE)) {
                    const where = {
                        ...(node.where ?? {}),
                        id: { _isOperator: true, op: "in", val: chunk },
                    };

                    const raws = Model._queryAllRaw(TargetClass, where, {
                        orderBy,
                        withSoftDeleted: node.withSoftDeleted,
                        onlySoftDeleted: node.onlySoftDeleted,
                        relationName: rel.propertyName,
                    });

                    const instances = Model._mapRawList(TargetClass, raws, node.select);

                    for (const item of instances) {
                        if (item.id) targetById.set(item.id, item);
                    }
                }

                for (const parent of parents) {
                    const fk = (parent as any)[rel.foreignKey];

                    Model._assignLoadedRelation(
                        parent,
                        rel.propertyName,
                        fk ? targetById.get(String(fk)) ?? null : null
                    );
                }

                break;
            }

            case "OneToMany": {
                if (!rel.foreignKey) return;

                const parentIds = Model._uniqueStrings(parents.map(parent => parent.id));
                const grouped = new Map<string, Model[]>();
                const select = Model._ensureSelect(node.select, [rel.foreignKey]);

                for (const id of parentIds) grouped.set(id, []);

                for (const chunk of _chunk(parentIds, RELATION_ID_CHUNK_SIZE)) {
                    const where = {
                        ...(node.where ?? {}),
                        [rel.foreignKey]: { _isOperator: true, op: "in", val: chunk },
                    };

                    const raws = Model._queryAllRaw(TargetClass, where, {
                        orderBy,
                        withSoftDeleted: node.withSoftDeleted,
                        onlySoftDeleted: node.onlySoftDeleted,
                        relationName: rel.propertyName,
                    });

                    const instances = Model._mapRawList(TargetClass, raws, select);

                    for (const item of instances) {
                        const parentId = String((item as any)[rel.foreignKey]);

                        if (!grouped.has(parentId)) grouped.set(parentId, []);
                        grouped.get(parentId)!.push(item);
                    }
                }

                for (const parent of parents) {
                    const id = parent.id ? String(parent.id) : "";
                    let items = grouped.get(id) ?? [];

                    if (orderBy) items = Model._sortModelsInMemory(items, orderBy);
                    items = Model._applyRelationLimit(items, node);

                    Model._assignLoadedRelation(parent, rel.propertyName, items);
                }

                break;
            }

            case "ManyToMany": {
                if (!rel.pivotEntity || !rel.pivotLocalKey || !rel.pivotForeignKey) return;

                const PivotClass = rel.pivotEntity() as ModelClass<Model>;
                Model._warmModelCache(PivotClass);
                const pivotColumns = PivotClass._columns();
                const localColMeta = pivotColumns.find(c => c.propertyName === rel.pivotLocalKey);
                const foreignColMeta = pivotColumns.find(c => c.propertyName === rel.pivotForeignKey);

                if (!localColMeta || !foreignColMeta) return;

                const parentIds = Model._uniqueStrings(parents.map(parent => parent.id));
                const pivotsByParent = new Map<string, any[]>();

                for (const id of parentIds) pivotsByParent.set(id, []);

                for (const chunk of _chunk(parentIds, RELATION_ID_CHUNK_SIZE)) {
                    const pivotWhere = {
                        ...(node.pivotWhere ?? {}),
                        [rel.pivotLocalKey]: { _isOperator: true, op: "in", val: chunk },
                    };

                    const pivotRaws = Model._queryAllRaw(PivotClass, pivotWhere, {
                        withSoftDeleted: node.withSoftDeleted,
                        onlySoftDeleted: node.onlySoftDeleted,
                        relationName: `${rel.propertyName}:pivot`,
                    });

                    for (const pr of pivotRaws) {
                        const localId = String(pr[localColMeta.columnName]);

                        if (!pivotsByParent.has(localId)) pivotsByParent.set(localId, []);
                        pivotsByParent.get(localId)!.push(pr);
                    }
                }

                const foreignIdsInput: any[] = [];

                for (const pivotRows of Array.from(pivotsByParent.values())) {
                    for (const pr of pivotRows) {
                        foreignIdsInput.push(pr[foreignColMeta.columnName]);
                    }
                }

                const foreignIds = Model._uniqueStrings(foreignIdsInput);

                const targetRawById = new Map<string, any>();

                for (const chunk of _chunk(foreignIds, RELATION_ID_CHUNK_SIZE)) {
                    const targetWhere = {
                        ...(node.where ?? {}),
                        id: { _isOperator: true, op: "in", val: chunk },
                    };

                    const targetRaws = Model._queryAllRaw(TargetClass, targetWhere, {
                        orderBy,
                        withSoftDeleted: node.withSoftDeleted,
                        onlySoftDeleted: node.onlySoftDeleted,
                        relationName: rel.propertyName,
                    });

                    for (const raw of targetRaws) {
                        if (raw.id) targetRawById.set(String(raw.id), raw);
                    }
                }

                const allCreatedTargets: Model[] = [];
                const assignedByParent = new Map<string, Model[]>();

                for (const parentId of parentIds) {
                    const pivotRows = pivotsByParent.get(parentId) ?? [];
                    const items: Model[] = [];

                    for (const pr of pivotRows) {
                        const foreignId = String(pr[foreignColMeta.columnName]);
                        const targetRaw = targetRawById.get(foreignId);

                        if (!targetRaw) continue;

                        const entity = TargetClass.mapFromDb(targetRaw, node.select);

                        const pivotData: Record<string, any> = {};

                        for (const col of pivotColumns) {
                            if (
                                col.propertyName !== rel.pivotLocalKey &&
                                col.propertyName !== rel.pivotForeignKey
                            ) {
                                pivotData[col.propertyName] = pr[col.columnName];
                            }
                        }

                        entity.withPivot(pivotData);

                        items.push(entity);
                        allCreatedTargets.push(entity);
                    }

                    assignedByParent.set(parentId, items);
                }

                TargetClass._resolveMLFields(allCreatedTargets, node.select);

                for (const parent of parents) {
                    const id = parent.id ? String(parent.id) : "";
                    let items = assignedByParent.get(id) ?? [];

                    if (orderBy) items = Model._sortModelsInMemory(items, orderBy);
                    items = Model._applyRelationLimit(items, node);

                    Model._assignLoadedRelation(parent, rel.propertyName, items);
                }

                break;
            }
        }
    }

    loadRelation<K extends RelationKeys<this>>(
        relationName: K,
        options?: LoadRelationOptions<this, K>
    ): this {
        const ctor = this.constructor as ModelClass<Model>;
        Model._ensureSchemaValidFor(ctor);

        const rel = this._getRelations().find(r => r.propertyName === String(relationName));

        if (!rel) {
            throw new ORMNotFoundError(ctor.name, String(relationName));
        }

        const spec = {
            [String(relationName)]: options ?? true,
        } as RelationSpec<this>;

        ctor._batchLoadRelations([this], spec as any);

        return this;
    }

    loadRelations(spec: RelationSpec<this>): this {
        const ctor = this.constructor as ModelClass<Model>;
        Model._ensureSchemaValidFor(ctor);


        ctor._batchLoadRelations([this], spec as any);

        return this;
    }

    static findOne<T extends Model>(
        this: ModelClass<T>,
        idOrWhere: string | WhereCondition<T>,
        options?: { select?: any[]; withSoftDeleted?: boolean; onlySoftDeleted?: boolean }
    ): T | null {
        Model._ensureSchemaValidFor(this as any);

        if (typeof idOrWhere === "object" && _hasEmptyIn(idOrWhere as any)) return null;

        const obj = db.dynamicObject(this._tableName());
        const select = options?.select as string[] | undefined;
        let raw: any = null;

        if (typeof idOrWhere === "string") {
            raw = obj.query(idOrWhere);

            if (raw && !this._rawPassesSoftDelete(raw, options)) raw = null;
        } else {
            const where = this._applySoftDeleteWhere(idOrWhere as Record<string, any>, options);
            const cond = this._buildCondition(where);

            const results = cond.conditions.length > 0
                ? obj.queryByCondition(cond, { options: { limit: 1 } })
                : obj.queryByCondition({}, { options: { limit: 1 } });

            raw = results?.[0] ?? null;
        }

        if (!raw) return null;

        const instance = this.mapFromDb(raw, select);

        this._resolveMLFields([instance], select);

        return instance as any;
    }

    static findOneOrFail<T extends Model>(
        this: ModelClass<T>,
        idOrWhere: string | WhereCondition<T>,
        options?: { select?: any[]; withSoftDeleted?: boolean; onlySoftDeleted?: boolean }
    ): T {
        Model._ensureSchemaValidFor(this as any);
        const result = this.findOne(idOrWhere, options);

        if (!result) {
            const desc = typeof idOrWhere === "string" ? `id='${idOrWhere}'` : JSON.stringify(idOrWhere);
            throw new ORMNotFoundError(this.name, desc);
        }

        return result as any;
    }

    static find<T extends Model>(
        this: ModelClass<T>,
        options?: FindOptions<T, any>
    ): T[] {
        Model._ensureSchemaValidFor(this as any);
        if (options?.where && _hasEmptyIn(options.where as any)) return [];
        if (options?.limit !== undefined && options.limit <= 0) return [];

        const obj = db.dynamicObject(this._tableName());
        const columns = this._columns();
        const select = options?.select as string[] | undefined;

        const colMap: Record<string, string> = {};
        for (const col of columns) colMap[col.propertyName] = col.columnName;

        const queryOptions: any = {};

        if (options?.orderBy) {
            queryOptions.orderby = options.orderBy.map(ob => ({
                field: colMap[String(ob.field)] ?? SYSTEM_FIELD_MAP[String(ob.field)] ?? String(ob.field),
                order: ob.order,
            }));
        } else {
            queryOptions.orderby = [{ field: "createdDate", order: db.Order.DESC }];
        }

        if (options?.limit !== undefined) {
            queryOptions.limit = options.limit;
        } else {
            console.warn(
                `[ORM Warning] No limit set on ${this.name}.find() — applying default limit ${DEFAULT_LIMIT}.`
            );
            queryOptions.limit = DEFAULT_LIMIT;
        }

        if (options?.offset !== undefined) queryOptions.skip = options.offset;

        const where = this._applySoftDeleteWhere(options?.where as any, options);
        const cond = this._buildCondition(where);

        const rawList = cond.conditions.length > 0
            ? obj.queryByCondition(cond, { options: queryOptions })
            : obj.queryByCondition({}, { options: queryOptions });

        const instances = rawList.map((raw: any) => this.mapFromDb(raw, select));

        this._resolveMLFields(instances, select);

        return instances as any;
    }

    static findAndCount<T extends Model>(
        this: ModelClass<T>,
        options?: FindOptions<T, any>
    ): [T[], number] {
        Model._ensureSchemaValidFor(this as any);
        if (options?.where && _hasEmptyIn(options.where as any)) return [[], 0];
        if (options?.limit !== undefined && options.limit <= 0) return [[], 0];

        const data = this.find(options);
        const where = this._applySoftDeleteWhere(options?.where as any, options);
        const cond = this._buildCondition(where);

        const total = cond.conditions.length > 0
            ? db.dynamicObject(this._tableName()).count(cond)
            : db.dynamicObject(this._tableName()).count();

        return [data, total];
    }

    static findWithRelations<T extends Model>(
        this: ModelClass<T>,
        options?: FindWithRelationsOptions<T, any>
    ): T[] {
        Model._ensureSchemaValidFor(this as any);
        if (options?.where && _hasEmptyIn(options.where as any)) return [];

        const rows = this.find(options);

        if (options?.relations && rows.length > 0) {
            this._batchLoadRelations(rows, options.relations as RelationSpec<T>);
        }

        return rows;
    }

    static findOneWithRelations<T extends Model>(
        this: ModelClass<T>,
        idOrWhere: string | WhereCondition<T>,
        relations?: RelationSpec<T>,
        options?: { select?: any[]; withSoftDeleted?: boolean; onlySoftDeleted?: boolean }
    ): T | null {
        Model._ensureSchemaValidFor(this as any);
        const row = this.findOne(idOrWhere, options);

        if (!row) return null;

        if (relations) {
            this._batchLoadRelations([row], relations as RelationSpec<T>);
        }

        return row;
    }

    static findOneOrFailWithRelations<T extends Model>(
        this: ModelClass<T>,
        idOrWhere: string | WhereCondition<T>,
        relations?: RelationSpec<T>,
        options?: { select?: any[]; withSoftDeleted?: boolean; onlySoftDeleted?: boolean }
    ): T {
        Model._ensureSchemaValidFor(this as any);
        const row = this.findOneOrFail(idOrWhere, options);

        if (relations) {
            this._batchLoadRelations([row], relations as RelationSpec<T>);
        }

        return row;
    }

    static findAndCountWithRelations<T extends Model>(
        this: ModelClass<T>,
        options?: FindWithRelationsOptions<T, any>
    ): [T[], number] {
        Model._ensureSchemaValidFor(this as any);
        const [rows, total] = this.findAndCount(options);

        if (options?.relations && rows.length > 0) {
            this._batchLoadRelations(rows, options.relations as RelationSpec<T>);
        }

        return [rows, total];
    }

    static count<T extends Model>(
        this: ModelClass<T>,
        where?: WhereCondition<T>,
        options?: { withSoftDeleted?: boolean; onlySoftDeleted?: boolean }
    ): number {
        Model._ensureSchemaValidFor(this as any);
        if (where && _hasEmptyIn(where as any)) return 0;

        const finalWhere = this._applySoftDeleteWhere(where as any, options);
        const cond = this._buildCondition(finalWhere);

        if (cond.conditions.length === 0) {
            return db.dynamicObject(this._tableName()).count();
        }

        return db.dynamicObject(this._tableName()).count(cond);
    }

    static isExists<T extends Model>(
        this: ModelClass<T>,
        where: string | WhereCondition<T>,
        options?: { withSoftDeleted?: boolean; onlySoftDeleted?: boolean }
    ): boolean {
        Model._ensureSchemaValidFor(this as any);
        if (typeof where === "string") return this.findOne(where, options) !== null;
        if (where && typeof where === "object" && _hasEmptyIn(where as any)) return false;

        return this.count(where, options) > 0;
    }

    static batchInsert<T extends Model>(
        this: ModelClass<T>,
        records: T[],
        _isRetry = false
    ): void {
        Model._ensureSchemaValidFor(this as any);
        if (records.length === 0) return;

        const obj = db.dynamicObject(this._tableName());
        const columns = this._columns();

        for (const record of records) {
            (record as any)._validate();
        }

        const plainRecords = records.map(record => (record as any)._buildInsertRecord(columns));
        const firstKeys = Object.keys(plainRecords[0] ?? {}).sort().join(",");
        const allSameShape = plainRecords.every(r => Object.keys(r).sort().join(",") === firstKeys);
        const flag = allSameShape ? { bulkImport: true } : undefined;
        const chunks = _chunk(plainRecords, BATCH_CHUNK_SIZE);

        let offset = 0;

        try {
            for (const chunk of chunks) {
                const ids = obj.batchInsert(chunk, flag) as string[];

                for (let i = 0; i < chunk.length; i++) {
                    const rec = records[offset + i] as any;

                    rec.id = ids[i];
                    rec.__isNew = false;
                    rec.__dirtyFields = new Set();
                    rec.__relationDirty = new Set();
                }

                offset += chunk.length;
            }
        } catch (err: any) {
            const retry = (): void => this.batchInsert(records, true);

            const result = _handleCaughtError(
                err,
                retry,
                !_isRetry,
                () => this.handleDbError(err, this)
            );

            return result as void;
        }
    }

    static batchUpdate<T extends Model>(
        this: ModelClass<T>,
        records: T[],
        _isRetry = false
    ): void {
        Model._ensureSchemaValidFor(this as any);
        if (records.length === 0) return;

        const obj = db.dynamicObject(this._tableName());
        const columns = this._columns();

        const colMap: Record<string, string> = {};
        for (const col of columns) colMap[col.propertyName] = col.columnName;

        const dirtyRecords = records.filter(r => r.__dirtyFields.size > 0);

        if (dirtyRecords.length === 0) return;

        for (const record of dirtyRecords) {
            (record as any)._validate();
        }

        const plainRecords: any[] = [];

        for (const record of dirtyRecords) {
            const self = record as any;
            const plain: any = { id: record.id };

            for (const field of Array.from(record.__dirtyFields)) {
                const colMeta = columns.find(c => c.propertyName === field);

                if (colMeta?.readOnly) continue;

                if (colMeta?.type === "multiLanguage") {
                    const oldResourceId = self.__originalValues?.get(field) as string | undefined;
                    const oldResolved = oldResourceId ? MLHelper.resolveAll(oldResourceId) : undefined;

                    MLHelper.update(oldResourceId ?? "", oldResolved, self[field] as MLValue, colMeta);
                    continue;
                }

                const colName = colMap[field] ?? SYSTEM_FIELD_MAP[field];

                if (!colName) continue;

                let val = self[field];

                if ((colMeta?.type === "date" || colMeta?.type === "datetime") && val !== null && val !== undefined) {
                    val = toUtcISOString(val);
                }

                if (colMeta?.type === "picklistMulti" && Array.isArray(val)) {
                    val = val.join(";");
                }

                plain[colName] = val;
            }

            if (Object.keys(plain).length > 1) plainRecords.push(plain);
        }

        if (plainRecords.length === 0) return;

        try {
            for (const chunk of _chunk(plainRecords, BATCH_CHUNK_SIZE)) {
                obj.batchUpdate(chunk);
            }
        } catch (err: any) {
            const retry = (): void => this.batchUpdate(records, true);

            const result = _handleCaughtError(
                err,
                retry,
                !_isRetry,
                () => this.handleDbError(err, this)
            );

            return result as void;
        }

        for (const record of dirtyRecords) {
            (record as any).__dirtyFields = new Set();
            (record as any).__relationDirty = new Set();
        }
    }

    static batchDelete<T extends Model>(
        this: ModelClass<T>,
        records: T[],
        options?: DeleteOptions<T>,
        _isRetry = false
    ): void {
        Model._ensureSchemaValidFor(this as any);
        if (records.length === 0) return;

        if (this._deletedAtColumn()) {
            try {
                for (const record of records) {
                    record.delete(options as any);
                }

                return;
            } catch (err: any) {
                const retry = (): void => this.batchDelete(records, options, true);

                const result = _handleCaughtError(
                    err,
                    retry,
                    !_isRetry,
                    () => this.handleDbError(err, this)
                );

                return result as void;
            }
        }

        return this.forceBatchDelete(records, options, _isRetry);
    }

    static forceBatchDelete<T extends Model>(
        this: ModelClass<T>,
        records: T[],
        options?: DeleteOptions<T>,
        _isRetry = false
    ): void {
        Model._ensureSchemaValidFor(this as any);
        if (records.length === 0) return;

        const tableName = this._tableName();
        const columns = this._columns();
        const relations = this._relations();
        const ids = records.map(r => r.id).filter((id): id is string => !!id);

        if (ids.length === 0) return;

        const mlCols = columns.filter(c => c.type === "multiLanguage");

        if (mlCols.length > 0) {
            const raws = db.dynamicObject(tableName).queryByCondition({
                conjunction: db.Conjunction.AND,
                conditions: [{ field: "id", operator: "in", value: ids }],
            });

            for (const raw of raws) {
                for (const col of mlCols) {
                    const resourceId = raw[col.columnName];

                    if (resourceId) MLHelper.delete(resourceId);
                }
            }
        }

        const runRelation = (rel: RelationMeta): void => {
            const TargetClass = rel.target() as ModelClass<Model>;
            Model._warmModelCache(TargetClass);

            if (rel.type === "OneToMany") {
                if (!rel.foreignKey) return;

                const targetCols = TargetClass._columns();
                const colMeta = targetCols.find(c => c.propertyName === rel.foreignKey);
                const colName = colMeta?.columnName ?? rel.foreignKey;

                const raws = db.dynamicObject(TargetClass._tableName()).queryByCondition({
                    conjunction: db.Conjunction.AND,
                    conditions: [{ field: colName, operator: "in", value: ids }],
                });

                if (raws.length > 0) {
                    const children = raws.map((r: any) => TargetClass.mapFromDb(r));

                    TargetClass.forceBatchDelete(children as any);
                }

                return;
            }

            if (rel.type === "ManyToMany") {
                if (!rel.pivotEntity || !rel.pivotLocalKey) return;

                const PivotClass = rel.pivotEntity() as typeof Model;
                Model._warmModelCache(PivotClass);

                const pivotColumns = PivotClass._columns();
                const localColMeta = pivotColumns.find(c => c.propertyName === rel.pivotLocalKey);

                if (!localColMeta) return;

                db.dynamicObject(PivotClass._tableName()).deleteByCondition({
                    conjunction: db.Conjunction.AND,
                    conditions: [{ field: localColMeta.columnName, operator: "in", value: ids }],
                });
            }
        };

        for (const rel of relations) {
            if (rel.cascadeType === "master") runRelation(rel);
        }

        if (options?.relations) {
            const spec = options.relations as Record<string, any>;

            for (const rel of relations) {
                if (rel.cascadeType === "master") continue;
                if (spec[rel.propertyName]) runRelation(rel);
            }
        }

        try {
            for (const chunk of _chunk(ids, BATCH_CHUNK_SIZE)) {
                db.dynamicObject(tableName).deleteByCondition({
                    conjunction: db.Conjunction.AND,
                    conditions: [{ field: "id", operator: "in", value: chunk }],
                });
            }
        } catch (err: any) {
            const retry = (): void => this.forceBatchDelete(records, options, true);

            const result = _handleCaughtError(
                err,
                retry,
                !_isRetry,
                () => this.handleDbError(err, this)
            );

            return result as void;
        }

        for (const record of records) {
            const self = record as any;

            self.id = undefined;
            self.__isNew = true;
        }
    }

    protected static handleDbError(err: any, attemptedData?: any): never {
        const msg = err?.message || String(err);

        const requiredMatch = msg.match(/required field ([\w_]+) is missing|required field ([\w_]+) is null/i);

        if (requiredMatch) {
            const field = requiredMatch[1] || requiredMatch[2];
            throw new ORMRequiredFieldError(field);
        }

        const uniqueMatch = msg.match(/unique constraint|duplicate/i);

        if (uniqueMatch) throw new ORMDuplicateError("field");

        console.log("DatabaseError: " + msg);

        throw new ORMError("DatabaseError", "Database operation failed", 500, {
            message: msg,
            attemptedData,
        });
    }
}

export { Model as ActiveRecord };

function _walkColumns(ctor: Function): ColumnMeta[] {
    const result: ColumnMeta[] = [];
    let proto: Function = ctor;

    while (proto && proto !== Function.prototype) {
        for (const col of getColumns(proto)) {
            if (!result.find(c => c.propertyName === col.propertyName)) {
                result.push(col);
            }
        }

        proto = Object.getPrototypeOf(proto);
    }

    return result;
}

function _walkRelations(ctor: Function): RelationMeta[] {
    const result: RelationMeta[] = [];
    let proto: Function = ctor;

    while (proto && proto !== Function.prototype) {
        for (const rel of getRelations(proto)) {
            if (!result.find(r => r.propertyName === rel.propertyName)) {
                result.push(rel);
            }
        }

        proto = Object.getPrototypeOf(proto);
    }

    return result;
}

function _chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }

    return chunks;
}

function toDateOnlyString(val: any): string {
    if (typeof val === "string") {
        // already date
        if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;

        // ISO like 2027-01-09T16:00:00.000Z
        const m = val.match(/^(\d{4}-\d{2}-\d{2})T/);
        if (m && m[1]) return m[1];

        throw new ORMValidationError({ date: `Invalid date string: ${val}` });
    }

    if (val instanceof Date) {
        // local date parts (avoid UTC shift)
        const y = val.getFullYear();
        const m = String(val.getMonth() + 1).padStart(2, "0");
        const d = String(val.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }

    throw new ORMValidationError({ date: `Invalid date value: ${val}` });
}