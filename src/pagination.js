const { z, date } = require("./validation");

function pagination(query, pageKey = "page") {
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .parse(query[pageKey] ?? 1);
  const page_size = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(query.page_size ?? 50);
  return { page, page_size, offset: (page - 1) * page_size };
}

function period(query) {
  return z
    .object({
      date_from: date.nullable(),
      date_to: date.nullable(),
    })
    .refine(
      (value) =>
        !value.date_from || !value.date_to || value.date_from <= value.date_to,
      "Начало периода должно быть не позже окончания",
    )
    .parse({
      date_from: query.date_from || null,
      date_to: query.date_to || null,
    });
}

const pageResult = (items, total, paging) => ({
  items,
  page: paging.page,
  page_size: paging.page_size,
  total: Number(total),
  pages: Math.max(1, Math.ceil(Number(total) / paging.page_size)),
});

// Caller may provide a function to place LIMIT inside a materialized page CTE,
// before expensive per-row aggregates. All SQL fragments are application code.
async function queryPage(
  tx,
  { countSql, itemsSql, values = [], paging, summary },
) {
  const count = await tx.query(countSql, values);
  const limit = `$${values.length + 1}`;
  const offset = `$${values.length + 2}`;
  const sql =
    typeof itemsSql === "function"
      ? itemsSql({ limit, offset })
      : `${itemsSql} LIMIT ${limit} OFFSET ${offset}`;
  const { rows } = await tx.query(sql, [
    ...values,
    paging.page_size,
    paging.offset,
  ]);
  const result = pageResult(rows, count.rows[0].count, paging);
  if (summary) result.summary = summary(count.rows[0]);
  return result;
}

const readSnapshot = (db, fn) =>
  db.transaction(async (tx) => {
    await tx.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    return fn(tx);
  });

const readPage = (db, options) =>
  readSnapshot(db, (tx) => queryPage(tx, options));

module.exports = {
  pagination,
  period,
  pageResult,
  queryPage,
  readPage,
  readSnapshot,
};
