const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const rateLimit = require("express-rate-limit");

function imageSize(data, type) {
  if (!Buffer.isBuffer(data)) return null;
  if (type === "image/png") {
    if (
      data.length < 33 ||
      !data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      data.readUInt32BE(8) !== 13 ||
      data.toString("ascii", 12, 16) !== "IHDR"
    )
      return null;
    return {
      extension: "png",
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  }
  if (
    type !== "image/jpeg" ||
    data.length < 4 ||
    data[0] !== 255 ||
    data[1] !== 216 ||
    data[data.length - 2] !== 255 ||
    data[data.length - 1] !== 217
  )
    return null;
  // Read dimensions before the compressed scan without decoding uploaded pixels.
  const frames = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < data.length) {
    if (data[offset++] !== 255) return null;
    while (offset < data.length && data[offset] === 255) offset++;
    const marker = data[offset++];
    if (
      marker === 0xda ||
      marker === 0xd9 ||
      marker === 0 ||
      offset + 2 > data.length
    )
      return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    if (frames.has(marker)) {
      if (
        length < 8 ||
        data[offset + 7] < 1 ||
        length !== 8 + 3 * data[offset + 7]
      )
        return null;
      return {
        extension: "jpg",
        width: data.readUInt16BE(offset + 5),
        height: data.readUInt16BE(offset + 3),
      };
    }
    offset += length;
  }
  return null;
}

async function publishImage(root, name, data) {
  const temporary = path.join(root, `.${crypto.randomUUID()}.tmp`);
  const destination = path.join(root, name);
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      // An atomic link makes a complete file visible without overwriting a concurrent upload.
      await fs.link(temporary, destination);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await fs.lstat(destination);
      if (!existing.isFile() || existing.size !== data.length)
        throw new Error("Existing upload is incomplete");
    }
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function registerUploadRoutes(app, { db, requireRole, wrap }) {
  const root = path.resolve(
    process.env.UPLOAD_DIR || path.join(__dirname, "../.local/uploads"),
  );
  const limiter = rateLimit({
    windowMs: 3600000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Лимит загрузок: попробуйте через час." },
  });
  app.post(
    "/api/uploads/images",
    requireRole("manager"),
    limiter,
    express.raw({ type: ["image/jpeg", "image/png"], limit: "10mb" }),
    wrap(async (req, res) => {
      const data = req.body;
      const dimensions = imageSize(data, req.get("Content-Type"));
      if (!dimensions || !dimensions.width || !dimensions.height)
        return res
          .status(400)
          .json({ error: "Выберите изображение JPG или PNG до 10 МБ." });
      if (dimensions.width > 20000 || dimensions.height > 20000)
        return res.status(400).json({
          error:
            "Изображение слишком большое. Максимум 20 000 пикселей по стороне.",
        });
      const name = `${crypto.createHash("sha256").update(data).digest("hex")}.${dimensions.extension}`;
      await db.transaction(async (tx) => {
        const { rows } = await tx.query(
          "SELECT role,status,auth_version FROM users WHERE id=$1 FOR SHARE",
          [req.user.id],
        );
        const actor = rows[0];
        if (
          !actor ||
          actor.status === "closed" ||
          actor.auth_version !== req.session.authVersion
        )
          throw Object.assign(new Error("Сессия завершена. Войдите снова."), {
            status: 401,
          });
        if (!["manager", "admin"].includes(actor.role))
          throw Object.assign(new Error("Недостаточно прав"), { status: 403 });
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        const disk = await fs.statfs(root);
        if (disk.bavail * disk.bsize < 1024 * 1024 * 1024 + data.length)
          throw Object.assign(
            new Error(
              "Недостаточно свободного места для загрузки. Обратитесь к администратору.",
            ),
            { status: 507 },
          );
        await publishImage(root, name, data);
      });
      res.status(201).json({ url: `/uploads/${name}` });
    }),
  );
  app.get(
    "/uploads/:name",
    wrap(async (req, res, next) => {
      if (!/^[a-f0-9]{64}\.(png|jpg)$/.test(req.params.name))
        return res.sendStatus(404);
      res.set({
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      });
      res.sendFile(req.params.name, { root, dotfiles: "deny" }, (error) => {
        if (!error) return;
        if (res.headersSent) return next(error);
        if (error.code === "ENOENT" || error.status === 404) {
          res.removeHeader("Cache-Control");
          return res.sendStatus(404);
        }
        next(error);
      });
    }),
  );
}
module.exports = { registerUploadRoutes };
