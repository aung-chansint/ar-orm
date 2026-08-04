import * as db from "db";
import { v4 as uuidv4 } from "uuid";
import { MLValue } from "./MBTI__ARTypes";
import { ColumnMeta } from "./MBTI__ARDecorators";

// ============================================================================
// CONSTANTS
// ============================================================================

export const DEFAULT_LANGUAGES: string[] = ["en_US", "zh_CN", "my_MM"];

// ============================================================================
// ML HELPER
// ============================================================================

export class MLHelper {

    // -------------------------------------------------------------------------
    // create — insert CustomResource + CustomResourceValue rows
    // returns new resourceId
    // -------------------------------------------------------------------------

    static create(value: MLValue | null | undefined, col: ColumnMeta): string {
        // always create a CustomResource record
        const resourceId = db.setup("CustomResource").insert({ name: uuidv4() }) as string;

        if (!value) return resourceId;

        const rows = MLHelper._buildValueRows(resourceId, value, col);
        if (rows.length > 0) {
            db.setup("CustomResourceValue").batchInsert(rows);
        }

        return resourceId;
    }

    // -------------------------------------------------------------------------
    // resolveAll — load all translations for one resourceId
    // -------------------------------------------------------------------------

    static resolveAll(resourceId: string): MLValue {
        if (!resourceId) return {};

        const raws = db.setup("CustomResourceValue").queryByCondition({
            conjunction: db.Conjunction.AND,
            conditions: [
                { field: "name", operator: "eq", value: resourceId },
            ],
        });

        const result: MLValue = {};
        for (const raw of raws) {
            if (raw.language && raw.value !== undefined) {
                result[raw.language] = raw.value;
            }
        }
        return result;
    }

    // -------------------------------------------------------------------------
    // resolveAllBatch — load translations for many resourceIds in one query
    // returns Map<resourceId, MLValue>
    // -------------------------------------------------------------------------

    static resolveAllBatch(ids: string[]): Map<string, MLValue> {
        const result = new Map<string, MLValue>();
        if (ids.length === 0) return result;

        const raws = db.setup("CustomResourceValue").queryByCondition({
            conjunction: db.Conjunction.AND,
            conditions: [
                { field: "name", operator: "in", value: ids },
            ],
        });

        for (const raw of raws) {
            if (!raw.name || !raw.language) continue;
            if (!result.has(raw.name)) result.set(raw.name, {});
            result.get(raw.name)![raw.language] = raw.value ?? "";
        }

        return result;
    }

    // -------------------------------------------------------------------------
    // update — diff old vs new, only delete+reinsert changed languages
    // -------------------------------------------------------------------------

    static update(
        resourceId: string,
        oldValue: MLValue | null | undefined,
        newValue: MLValue | null | undefined,
        col: ColumnMeta
    ): void {
        if (!resourceId) return;

        const langs = col.languages ?? DEFAULT_LANGUAGES;

        // collect all languages across old, new, and configured langs
        const allLangs = new Set<string>([
            ...langs,
            ...Object.keys(oldValue ?? {}),
            ...Object.keys(newValue ?? {}),
        ]);

        const toDelete: string[] = [];
        const toInsert: any[] = [];

        for (const lang of Array.from(allLangs)) {
            const oldText = oldValue?.[lang] ?? "";
            const newText = newValue?.[lang] ?? "";

            if (oldText === newText) continue; // no change — skip

            if (oldText !== "") toDelete.push(lang);
            if (newText !== "") toInsert.push({
                name: resourceId,
                language: lang,
                value: newText,
            });
        }

        if (toDelete.length > 0) {
            db.setup("CustomResourceValue").deleteByCondition({
                conjunction: db.Conjunction.AND,
                conditions: [
                    { field: "name", operator: "eq", value: resourceId },
                    { field: "language", operator: "in", value: toDelete },
                ],
            });
        }

        if (toInsert.length > 0) {
            db.setup("CustomResourceValue").batchInsert(toInsert);
        }
    }

    // -------------------------------------------------------------------------
    // delete — remove all CustomResourceValue rows + CustomResource record
    // -------------------------------------------------------------------------

    static delete(resourceId: string): void {
        if (!resourceId) return;

        db.setup("CustomResourceValue").deleteByCondition({
            conjunction: db.Conjunction.AND,
            conditions: [
                { field: "name", operator: "eq", value: resourceId },
            ],
        });

        db.setup("CustomResource").deleteByCondition({
            conjunction: db.Conjunction.AND,
            conditions: [
                { field: "id", operator: "eq", value: resourceId },
            ],
        });
    }

    // -------------------------------------------------------------------------
    // PRIVATE — build CustomResourceValue insert rows
    // skips empty strings, handles configured + extra languages
    // -------------------------------------------------------------------------

    private static _buildValueRows(
        resourceId: string,
        value: MLValue,
        col: ColumnMeta
    ): any[] {
        const langs = col.languages ?? DEFAULT_LANGUAGES;
        const seen = new Set<string>();
        const rows: any[] = [];

        // configured languages first
        for (const lang of langs) {
            seen.add(lang);
            const text = value[lang];
            if (!text || text === "") continue;
            rows.push({ name: resourceId, language: lang, value: text });
        }

        // any extra languages in the value object not in configured list
        for (const lang of Object.keys(value)) {
            if (seen.has(lang)) continue;
            const text = value[lang];
            if (!text || text === "") continue;
            rows.push({ name: resourceId, language: lang, value: text });
        }

        return rows;
    }
}