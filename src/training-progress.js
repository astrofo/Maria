// A completion belongs to the current lesson contents, not only its stable ID.
// The same predicate is used by admission checks and aggregate onboarding.
const courseAvailable = (alias = "c", status = "u.status") => `
  ${alias}.status='published' AND ${alias}.archived_at IS NULL
  AND (${alias}.document->>'audience'='all' OR ${alias}.document->>'audience'=${status})
  AND (${alias}.document->>'starts_at' IS NULL OR (${alias}.document->>'starts_at')::timestamptz<=NOW())
  AND (${alias}.document->>'ends_at' IS NULL OR (${alias}.document->>'ends_at')::timestamptz>NOW())`;

async function readTrainingRequirements(tx, courseIds, user, lock = false) {
  const ids = [...new Set(courseIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows } = await tx.query(
    `SELECT c.id,c.status,c.archived_at,
      (${courseAvailable("c", "$3")}) AS available,
      jsonb_array_length(c.document->'lessons') AS total,
      (SELECT COUNT(*)::int FROM jsonb_array_elements(c.document->'lessons') lesson
        JOIN course_lesson_progress p ON p.course_id=c.id AND p.user_id=$2
          AND p.lesson_id=lesson->>'id' AND p.content_hash=lesson->>'content_hash'
        WHERE p.completed_at IS NOT NULL) AS completed
     FROM courses c WHERE c.id=ANY($1::bigint[]) ORDER BY c.id${lock ? " FOR SHARE OF c" : ""}`,
    [ids, user.id, user.status],
  );
  const found = new Map(rows.map((row) => [String(row.id), row]));
  return new Map(
    ids.map((id) => {
      const row = found.get(String(id));
      return [
        String(id),
        {
          course_id: Number(id),
          // Previously completed current material remains sufficient after its
          // enrollment window ends; withdrawn or archived courses cannot admit.
          completed: Boolean(
            row &&
              row.status === "published" &&
              !row.archived_at &&
              row.total > 0 &&
              row.completed === row.total,
          ),
          available: Boolean(row?.available),
        },
      ];
    }),
  );
}

async function requireEventTraining(tx, event, user) {
  if (!event.required_course_id) return;
  // Hold the course through the admission write: publication/content updates
  // must not replace the material between checking it and accepting a person.
  const requirements = await readTrainingRequirements(
    tx,
    [event.required_course_id],
    user,
    true,
  );
  const requirement = requirements.get(String(event.required_course_id));
  if (requirement.completed) return;
  throw Object.assign(
    new Error(
      requirement.available
        ? "Сначала завершите обязательный курс подготовки к мероприятию."
        : "Обязательный курс подготовки сейчас недоступен. Обратитесь к организатору.",
    ),
    {
      status: 409,
      code: requirement.available
        ? "required_course_incomplete"
        : "required_course_unavailable",
      required_course_id: Number(event.required_course_id),
    },
  );
}

module.exports = {
  courseAvailable,
  readTrainingRequirements,
  requireEventTraining,
};
