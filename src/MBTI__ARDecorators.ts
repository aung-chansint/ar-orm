export type ColumnType =
    | "text"
    | "encryptedText"
    | "textArea"
    | "number"
    | "percent"
    | "currency"
    | "phone"
    | "email"
    | "url"
    | "date"
    | "datetime"
    | "checkbox"
    | "picklist"
    | "picklistMulti"
    | "multiLanguage";

export type SystemColumnType =
    | "createdAt"
    | "updatedAt"
    | "createdBy"
    | "updatedBy"
    | "deletedAt"
    | "deletedBy";

export interface ColumnMeta {
    propertyName: string;
    columnName: string;
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    validate?: (value: any) => void;
    type?: ColumnType;
    unique?: boolean;
    readOnly?: boolean;
    allowedValues?: string[];
    languages?: string[];
    system?: SystemColumnType;
}

export interface ColumnOptions {
    name: string;
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    validate?: (value: any) => void;
    type?: ColumnType;
    unique?: boolean;
    readOnly?: boolean;
    allowedValues?: string[];
    languages?: string[];
}

export type RelationType =
    | "OneToMany"
    | "ManyToOne"
    | "OneToOne"
    | "ManyToMany";

export type CascadeType = "master" | "detail" | "lookup";

export interface RelationMeta {
    propertyName: string;
    type: RelationType;
    target: () => Function;
    foreignKey?: string;
    cascadeType?: CascadeType;
    pivotEntity?: () => Function;
    pivotLocalKey?: string;
    pivotForeignKey?: string;
}

const _columnMap = new Map<Function, ColumnMeta[]>();
const _relationMap = new Map<Function, RelationMeta[]>();
const _tableMap = new Map<Function, string>();

export function getTableName(ctor: Function): string | undefined {
    return _tableMap.get(ctor);
}

export function getColumns(ctor: Function): ColumnMeta[] {
    return _columnMap.get(ctor) ?? [];
}

export function getRelations(ctor: Function): RelationMeta[] {
    return _relationMap.get(ctor) ?? [];
}

function getCtor(target: any): Function {
    return typeof target === "function" ? target : target.constructor;
}

function addColumn(ctor: Function, meta: ColumnMeta): void {
    const cols = _columnMap.get(ctor) ?? [];
    const index = cols.findIndex(c => c.propertyName === meta.propertyName);

    if (index >= 0) cols[index] = meta;
    else cols.push(meta);

    _columnMap.set(ctor, cols);
}

function addRelation(ctor: Function, meta: RelationMeta): void {
    const rels = _relationMap.get(ctor) ?? [];
    const index = rels.findIndex(r => r.propertyName === meta.propertyName);

    if (index >= 0) rels[index] = meta;
    else rels.push(meta);

    _relationMap.set(ctor, rels);
}

export function Entity(tableName: string) {
    return function (ctor: Function): void {
        _tableMap.set(ctor, tableName);
    };
}

export function Column(options: ColumnOptions) {
    return function (target: any, propertyName: string): void {
        const meta: ColumnMeta = {
            propertyName,
            columnName: options.name,
        };

        if (options.required !== undefined) meta.required = options.required;
        if (options.minLength !== undefined) meta.minLength = options.minLength;
        if (options.maxLength !== undefined) meta.maxLength = options.maxLength;
        if (options.min !== undefined) meta.min = options.min;
        if (options.max !== undefined) meta.max = options.max;
        if (options.validate !== undefined) meta.validate = options.validate;
        if (options.type !== undefined) meta.type = options.type;
        if (options.unique !== undefined) meta.unique = options.unique;
        if (options.readOnly !== undefined) meta.readOnly = options.readOnly;
        if (options.allowedValues !== undefined) meta.allowedValues = options.allowedValues;
        if (options.languages !== undefined) meta.languages = options.languages;

        addColumn(getCtor(target), meta);
    };
}

function SystemColumn(
    columnName: string,
    system: SystemColumnType,
    type: ColumnType,
    readOnly: boolean
) {
    return function (target: any, propertyName: string): void {
        addColumn(getCtor(target), {
            propertyName,
            columnName,
            type,
            system,
            readOnly,
        });
    };
}

export function UpdatedAt() {
    return SystemColumn("lastModifiedDate", "updatedAt", "datetime", true);
}

export function CreatedBy() {
    return SystemColumn("createdBy", "createdBy", "text", true);
}

export function UpdatedBy() {
    return SystemColumn("lastModifiedBy", "updatedBy", "text", true);
}

export function DeletedAt(columnName: string) {
    return SystemColumn(columnName, "deletedAt", "datetime", false);
}

export function DeletedBy(columnName: string) {
    return SystemColumn(columnName, "deletedBy", "text", false);
}

export function OneToMany(
    target: () => Function,
    foreignKey: string,
    cascadeType: CascadeType = "detail"
) {
    return function (proto: any, propertyName: string): void {
        addRelation(getCtor(proto), {
            propertyName,
            type: "OneToMany",
            target,
            foreignKey,
            cascadeType,
        });
    };
}

export function ManyToOne(
    target: () => Function,
    foreignKey: string,
    cascadeType: CascadeType = "lookup"
) {
    return function (proto: any, propertyName: string): void {
        addRelation(getCtor(proto), {
            propertyName,
            type: "ManyToOne",
            target,
            foreignKey,
            cascadeType,
        });
    };
}

export function OneToOne(
    target: () => Function,
    foreignKey: string,
    cascadeType: CascadeType = "detail"
) {
    return function (proto: any, propertyName: string): void {
        addRelation(getCtor(proto), {
            propertyName,
            type: "OneToOne",
            target,
            foreignKey,
            cascadeType,
        });
    };
}

export function ManyToMany(
    target: () => Function,
    pivotEntity: () => Function,
    pivotLocalKey: string,
    pivotForeignKey: string
) {
    return function (proto: any, propertyName: string): void {
        addRelation(getCtor(proto), {
            propertyName,
            type: "ManyToMany",
            target,
            pivotEntity,
            pivotLocalKey,
            pivotForeignKey,
        });
    };
}