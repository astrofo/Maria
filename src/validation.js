const { z } = require("zod");
const text = (max) => z.string().trim().max(max);
const nullableText = (max) => text(max).nullable().optional();
const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
    "Некорректная дата",
  );
const birthday = date.refine(
  (v) => v <= new Date().toISOString().slice(0, 10) && v >= "1900-01-01",
  "Некорректная дата рождения",
);
const tags = z.array(text(80).min(1)).max(30).default([]);
const password = z
  .string()
  .min(12, "Используйте не меньше 12 символов")
  .max(128, "Не больше 128 символов");
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const profile = z.object({
  full_name: text(120).min(2),
  city: nullableText(120),
  phone: nullableText(40),
  birth_date: birthday.nullable().optional(),
  gender: z.enum(["female", "male", "unspecified"]).optional(),
  interests: tags,
  skills: tags,
  experience: nullableText(4000),
  participation_format: nullableText(120),
  participation_frequency: nullableText(120),
});
const eventFields = {
  cover_url: z
    .string()
    .regex(/^\/(uploads\/[a-f0-9]{64}\.(?:png|jpg)|assets\/[a-zA-Z0-9_./-]+)$/)
    .refine((v) => !v.includes(".."), "Некорректный адрес обложки")
    .nullable()
    .optional(),
  cover_alt: nullableText(300),
  coordinator_id: id.nullable().optional(),
  required_course_id: id.nullable().optional(),
  application_deadline: z.string().datetime().nullable().optional(),
  preparation: nullableText(8000),
  title: text(200).min(3),
  description: text(8000).min(3),
  city: nullableText(120),
  format: nullableText(100),
  location: nullableText(300),
  starts_at: z.string().datetime().nullable().optional(),
  ends_at: z.string().datetime().nullable().optional(),
  status: z.enum(["draft", "open", "closed"]).default("open"),
  visibility: z.enum(["public", "invite_only"]).default("public"),
  skills: tags,
  interests: tags,
  capacity: id.max(100000).nullable().optional(),
};
const opportunity = z
  .object(eventFields)
  .refine(
    (v) =>
      !v.starts_at ||
      !v.ends_at ||
      Date.parse(v.ends_at) > Date.parse(v.starts_at),
    "Конец мероприятия должен быть позже начала",
  );
const training = z.object({
  title: text(200).min(2),
  description: nullableText(4000),
  url: z
    .string()
    .url()
    .refine((v) => ["http:", "https:"].includes(new URL(v).protocol))
    .or(z.literal(""))
    .nullable()
    .optional(),
  required: z.boolean().default(false),
  published: z.boolean().default(true),
});
const participation = z
  .object({
    user_id: id,
    opportunity_id: id.nullable().optional(),
    title: text(200).min(2).optional(),
    participated_on: date.default(() => new Date().toISOString().slice(0, 10)),
    hours: z.coerce.number().positive().max(24),
    note: nullableText(2000),
  })
  .refine(
    (v) => v.opportunity_id || v.title,
    "Укажите мероприятие или название участия",
  );
module.exports = {
  z,
  text,
  id,
  date,
  birthday,
  tags,
  password,
  email,
  profile,
  opportunity,
  training,
  participation,
};
