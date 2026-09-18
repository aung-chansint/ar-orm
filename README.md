# AR ORM Usage

This ORM is designed for AppCube runtime (`db`, `context`) with Active Record style models.

## Recommended Write Patterns

- Use `Model.create(data, options)` for normal inserts.
- Use `Model.update(idOrWhere, data, options)` for normal single-row updates.
- Use `Model.sync(where, records, options)` to upsert a list; pass `deleteMissing: true` only to replace the whole `where` collection.
- Use `new Model() + save()` only when you need custom staged mutation before saving.
- Keep transaction boundaries in service layer for multi-table workflows.

### Create (recommended)

```ts
const reservation = PackageReservation.create({
  outletId,
  packageId,
  sessionId,
  appUserId,
  startDate,
  endDate,
  quantity,
  bookingRefNo,
  status: PackageReservationStatus.PENDING,
  subtotal,
  discountAmount: 0,
  couponAmount: 0,
  totalAmount,
  guestType,
});
```

### Update (recommended)

```ts
const payment = PackageReservationPayment.update(
  { packageReservationId: reservationId },
  {
    paymentStatus: PackageReservationPaymentStatus.SUCCESS,
    transactionNo,
    paidAt: new Date(),
  },
  { forUpdate: true }
);
```

- `update(...)` ignores `undefined` fields.
- `update(...)` is scalar-only by default; relation fields are ignored unless they are explicitly included via `options.relations`.
- Unchanged values are skipped to reduce no-op writes.

### Sync (upsert)

Default matching is `id`. Update payloads without `id` will not match existing rows — they are created. Use `syncBy` with business keys when you need to update without `id`.

```ts
// Update matching rows / create the rest. Other benefits for this package are left alone.
const synced = PackageBenefit.sync(
  { packageId },
  [
    { id: "existing-id-1", amenityId: "A1", name: { en_US: "Spa", my_MM: "Spa", zh_CN: "Spa" } },
    { amenityId: "A2", name: { en_US: "Breakfast", my_MM: "Breakfast", zh_CN: "Breakfast" } },
  ],
  { forUpdate: true }
);
```

- Existing rows in `where` with matching `id` are updated.
- Rows without `id` are created.
- Other rows in `where` are not deleted.
- Like `update(...)`, relation fields are ignored unless `options.relations` is set.

### Replace a collection (`deleteMissing`)

Pass the **full** desired list. Existing rows in `where` whose compare key is not in the payload are deleted.

```ts
const replaced = PackageBenefit.sync(
  { packageId },
  [
    { id: "existing-id-1", amenityId: "A1", name: { en_US: "Spa", my_MM: "Spa", zh_CN: "Spa" } },
    { amenityId: "A2", name: { en_US: "Breakfast", my_MM: "Breakfast", zh_CN: "Breakfast" } },
  ],
  {
    deleteMissing: true,
    forUpdate: true,
  }
);
```

- Omit `deleteMissing` for single-item / partial upserts; otherwise siblings in `where` are removed.
- `deleteMissing` is ignored if none of the payload rows have usable compare keys (for default `id`, that means no ids). This prevents wiping the scope when updating without keys.

### Sync By custom keys

```ts
// Default key is ["id"].
// For pivot tables, use composite keys.

// Upsert one/some pivots — other categories for this package are kept.
PackageCategories.syncBy(
  { packageId: pkg.id },
  [{ packageId: pkg.id, categoryId }],
  ["packageId", "categoryId"]
);

// Replace the whole collection for this package.
PackageCategories.syncBy(
  { packageId: pkg.id },
  payload.categoryIds.map(categoryId => ({ packageId: pkg.id, categoryId })),
  ["packageId", "categoryId"],
  { deleteMissing: true }
);
```

- `sync(...)` is shorthand for `syncBy(..., ["id"])`.
- If custom `by` is passed, rows are matched by those keys (not `id`).
- Updates without `id` must use `syncBy` with those keys, otherwise old rows cannot be matched.

## Column Defaults

`@Column` supports `default` values.

```ts
@Column({ name: "MBTI__sourceChannel__CST", type: "text", default: "MINIAPP" })
sourceChannel!: string;

@Column({ name: "MBTI__tags__CST", type: "picklistMulti", default: () => [] })
tags!: string[];
```

- Constant and function defaults are supported.
- Function defaults are evaluated per row.

## Hide fields from toJSON

Use `expose: false` on `@Column` to exclude a field from `toJSON()` output.

```ts
@Column({ name: "name", type: "text", expose: false })
nameValue?: string;
```

## Multi-language value shape

- `multiLanguage` fields always resolve with `null` for missing configured languages.
- Example: if only `en_US` exists, resolved value becomes `{ en_US: "...", zh_CN: null, my_MM: null }`.

## Relation Decorator Rules

- Cascade is explicit for all relations: only `"lookup" | "master"`.
- `OneToOne` requires explicit owner side:

```ts
@OneToOne(() => PackageReservationPayment, "packageReservationId", "lookup", "target")
payment!: PackageReservationPayment;
```

- `ManyToMany` also requires cascade:

```ts
@ManyToMany(() => Guest, () => PackageReservationGuest, "packageReservationId", "guestId", "lookup")
guests!: Guest[];
```

## Locking

- Use `forUpdate: true` on `find`/`findOne` family when row locks are required.
- You can also pass `forUpdate: true` inside relation nodes for `findWithRelations(...)` / `loadRelation(...)` when related rows must be locked.
- `count()` and `isExists()` do not allow `forUpdate`.

## Static delete by where

- Use `Model.delete(where, options?)` for bulk delete by filter.
- Supports soft delete by default and hard delete with `force: true`.

```ts
// Soft delete matching rows
PackageBenefit.delete({ packageId: pkg.id });

// Hard delete matching rows
PackageBenefit.delete({ packageId: pkg.id }, { force: true });
```

## Type Hints for Relations

For strict relation key hints in editor, declare relation map per model:

```ts
declare __relationTypes__: {
  payment: PackageReservationPayment;
  items: PackageReservationItem[];
  guests: Guest[];
};
```

This is type-only (`declare`) and has no runtime impact.
