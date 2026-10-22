const crypto = require("node:crypto");
const { promisify } = require("node:util");
const bcrypt = require("bcryptjs");
const scrypt = promisify(crypto.scrypt);

// New passwords support the complete Unicode string; existing bcrypt hashes remain usable.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
async function verifyPassword(password, hash) {
  if (typeof password !== "string" || typeof hash !== "string") return false;
  if (hash.startsWith("$2")) {
    return (
      Buffer.byteLength(password, "utf8") <= 72 &&
      bcrypt.compare(password, hash)
    );
  }
  const parts = hash.split("$");
  if (parts.length !== 6 || parts.slice(0, 4).join("$") !== "scrypt$16384$8$1")
    return false;
  const salt = Buffer.from(parts[4], "base64url"),
    expected = Buffer.from(parts[5], "base64url");
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = await scrypt(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(actual, expected);
}
module.exports = { hashPassword, verifyPassword };
