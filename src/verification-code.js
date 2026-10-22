const crypto = require("node:crypto");

const VERIFICATION_CODE_LENGTH = 4;
const DEMO_VERIFICATION_CODE = "1234";
const codePattern = new RegExp(`^[0-9]{${VERIFICATION_CODE_LENGTH}}$`);

function emailCodeMode(env = process.env) {
  const mode = env.EMAIL_CODE_MODE || "random";
  if (!["random", "fixed_demo"].includes(mode))
    throw new Error("EMAIL_CODE_MODE must be random or fixed_demo");
  return mode;
}

const isDemoEmailCodeMode = (env = process.env) =>
  emailCodeMode(env) === "fixed_demo";

function emailDemoAccounts(env = process.env) {
  const accounts = (env.EMAIL_DEMO_ACCOUNTS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (
    accounts.some(
      (email) =>
        email.length > 254 ||
        email.includes("*") ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    )
  )
    throw new Error("EMAIL_DEMO_ACCOUNTS must contain exact email addresses");
  return [...new Set(accounts)].sort();
}

const isDemoEmailAccount = (email, env = process.env) =>
  typeof email === "string" &&
  emailDemoAccounts(env).includes(email.trim().toLowerCase());

// A demo login is restricted to an exact account; a global mode must never grant
// access to every registered user. Registration always requires real delivery.
const isDemoLoginEmail = (email, env = process.env) =>
  isDemoEmailAccount(email, env);

// Include the exact demo policy in code digests so a configuration change
// retires previously issued challenges instead of changing their meaning.
const emailCodePolicy = (env = process.env) =>
  JSON.stringify([
    "email-code-policy/v2",
    emailCodeMode(env),
    emailDemoAccounts(env),
  ]);

function createVerificationCode(env = process.env) {
  if (isDemoEmailCodeMode(env)) return DEMO_VERIFICATION_CODE;
  // Map a uniform range of 9,999 values around the reserved demo code.
  const value = crypto.randomInt(0, 10 ** VERIFICATION_CODE_LENGTH - 1);
  const code = value >= Number(DEMO_VERIFICATION_CODE) ? value + 1 : value;
  return code.toString().padStart(VERIFICATION_CODE_LENGTH, "0");
}
const isVerificationCode = (value) =>
  typeof value === "string" && codePattern.test(value);

module.exports = {
  VERIFICATION_CODE_LENGTH,
  DEMO_VERIFICATION_CODE,
  emailCodeMode,
  isDemoEmailCodeMode,
  emailDemoAccounts,
  isDemoEmailAccount,
  isDemoLoginEmail,
  emailCodePolicy,
  createVerificationCode,
  isVerificationCode,
};
