import dotenv from "dotenv";

// Load environment variables FIRST before creating ENV object
const envPath = process.env.DOTENV_CONFIG_PATH ?? "env.runtime";
const envResult = dotenv.config({ path: envPath });

if (envResult.error) {
  console.error(`[ENV] ⚠️ Failed to load env file: ${envResult.error.message}`);
} else {
  console.log(`[ENV] ✅ Environment file loaded from: ${envPath}`);
}

// Fallback: ถ้า MONGODB_URI ยังไม่มี (เช่น env.runtime หาย/โคลนใหม่) ลองโหลด .env
if (!process.env.MONGODB_URI) {
  const fallback = dotenv.config({ path: ".env" });
  if (fallback.parsed?.MONGODB_URI) {
    console.log("[ENV] ✅ MONGODB_URI loaded from .env (fallback)");
  }
}

console.log(`[ENV] JWT_SECRET is ${process.env.JWT_SECRET ? `set (length: ${process.env.JWT_SECRET.length})` : "NOT SET"}`);

export const ENV = {
  appId: process.env.VITE_APP_ID ?? process.env.APP_ID ?? "ordera-app",
  cookieSecret: process.env.JWT_SECRET ?? (() => {
    console.error("[ENV] ⚠️ JWT_SECRET is not set! Please set JWT_SECRET in env.runtime file.");
    return "";
  })(),
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  smtpHost: process.env.SMTP_HOST ?? "",
  smtpPort: process.env.SMTP_PORT ?? "587",
  smtpUser: process.env.SMTP_USER ?? "",
  smtpPassword: process.env.SMTP_PASSWORD ?? "",
  smtpFromEmail: process.env.SMTP_FROM_EMAIL ?? "",
  // รหัสสำหรับเข้าหน้าสร้างรหัสแอดมิน (ถ้าว่าง = ปิดใช้)
  masterCodeForAdminCodes: process.env.ORDERA_MASTER_CODE ?? "",
  // Super Admin (คุม Subscription/เปิด-ปิดร้าน) — ใส่เป็นอีเมลคั่นด้วย comma
  superAdminEmails: process.env.ORDERA_SUPER_ADMIN_EMAILS ?? "",
};
