import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import {
  publicProcedure,
  protectedProcedure,
  router,
  adminProcedure,
  managerProcedure,
  reportsProcedure,
  posProcedure,
  superAdminProcedure,
} from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { TRPCError } from "@trpc/server";
import { sendDailySalesReport, sendLowStockAlert, testEmailConnection } from "./_core/emailService";
import { sdk } from "./_core/sdk";
import { parse as parseCookie } from "cookie";
import { SignJWT, jwtVerify } from "jose";
import { ENV } from "./_core/env";
import { storeSettingsRouter } from "./routes/storeSettings";
import { deleteStoreAndOrgDataByStoreCode } from "./routes/superAdminDelete";
import { memberSignupRouter } from "./routes/memberSignup";

const ADMIN_CODES_SESSION_COOKIE = "ordera_admin_codes_session";
const ADMIN_CODES_SESSION_MAX_AGE = 60 * 60; // 1 ชม.

function isSuperAdminEmail(email: string | null | undefined): boolean {
  const raw = (ENV.superAdminEmails || "").trim();
  if (!raw) return false;
  const e = (email || "").trim().toLowerCase();
  if (!e) return false;
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.has(e);
}

async function verifyAdminCodesSessionCookie(cookieHeader: string | string[] | undefined): Promise<boolean> {
  const h = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  const parsed = parseCookie(h || "");
  const token = parsed[ADMIN_CODES_SESSION_COOKIE];
  if (!token) return false;
  try {
    const secret = new TextEncoder().encode(ENV.cookieSecret);
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    return (payload as { purpose?: string }).purpose === "admin-codes";
  } catch {
    return false;
  }
}

// ไม่ต้องใช้ adminProcedure ที่แก้ไขแล้ว เพราะเรามี managerProcedure แยกแล้ว

export const appRouter = router({
  system: systemRouter,
  storeSettings: storeSettingsRouter,
  memberSignup: memberSignupRouter,
  auth: router({
    me: publicProcedure
      .input(z.object({}).optional())
      .query((opts) => opts.ctx.user),
    register: publicProcedure
      .input(
        z.object({
          name: z.string().min(1, "ชื่อผู้ใช้ต้องไม่ว่าง"),
          email: z.string().email("รูปแบบอีเมลไม่ถูกต้อง"),
          password: z.string().min(6, "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร"),
        })
      )
      .mutation(async ({ input, ctx }) => {
        try {
          console.log("[Register] ========== START REGISTRATION ==========");
          console.log("[Register] Starting registration for:", input.email);
          
          const emailLower = input.email.toLowerCase();
          console.log("[Register] Searching for email (lowercase):", emailLower);
          
          // ✅ ตรวจสอบ email ก่อน (สำคัญมาก!)
          const existing = await db.getUserByEmail(input.email);
          if (existing) {
            console.log("[Register] ❌ Email already exists:", {
              id: existing.id,
              email: existing.email,
              name: existing.name,
              openId: existing.openId,
              role: existing.role
            });
            throw new TRPCError({
              code: "CONFLICT",
              message: "อีเมลนี้ถูกใช้งานแล้ว",
            });
          }
          console.log("[Register] ✅ Email is available");

          // ผู้ใช้ใหม่ = role "user" (ยังไม่มีร้าน) ต้องกรอกรหัสแอดมินเพื่อสร้างร้านและเป็น Admin
          const role = "user";
          console.log("[Register] Creating user:", { name: input.name, email: input.email, role });

          const newUser = await db.createInternalUser({
            name: input.name,
            email: input.email,
            password: input.password,
            role,
          });

          console.log("[Register] ✅ User created successfully:", { 
            id: newUser.id, 
            email: newUser.email, 
            openId: newUser.openId 
          });

          // ✅ สร้าง session token และ login อัตโนมัติ
          console.log("[Register] Creating session token...");
          try {
            const effectiveRole = newUser.role === "superadmin" || isSuperAdminEmail(newUser.email) ? "superadmin" : newUser.role;
            const sessionToken = await sdk.createSessionToken(newUser.openId, {
              name: newUser.name || "",
              role: effectiveRole,
            });
            console.log("[Register] ✅ Session token created");
          
            const cookieOptions = getSessionCookieOptions(ctx.req);
            ctx.res.cookie(COOKIE_NAME, sessionToken, {
              ...cookieOptions,
              maxAge: ONE_YEAR_MS,
            });
            console.log("[Register] ✅ Cookie set");
          } catch (tokenError) {
            console.error("[Register] ❌ Failed to create session token:", tokenError);
            // ⚠️ ถ้า session token creation fails แต่ user ถูกสร้างแล้ว
            // เรายังคง return success เพราะ user ถูกสร้างแล้ว
            // แต่จะไม่ set cookie (user ต้อง login ใหม่)
            console.warn("[Register] ⚠️ User created but session token failed - user can login manually");
          }

          console.log("[Register] ========== REGISTRATION SUCCESS ==========");
          return { success: true, message: "สมัครสมาชิกสำเร็จ" };
        } catch (error) {
          console.error("[Register] ========== REGISTRATION FAILED ==========");
          console.error("[Register] Error:", error);
          console.error("[Register] Error stack:", error instanceof Error ? error.stack : "No stack");
          if (error instanceof TRPCError) {
            throw error;
          }
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error("[Register] Unexpected error:", errorMessage);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `เกิดข้อผิดพลาดในการสมัครสมาชิก: ${errorMessage}`,
            cause: error,
          });
        }
      }),
    // สมัครร้าน (owner) — สร้างร้านสถานะ pending (ยังเข้า POS ไม่ได้ จนกว่า Super Admin จะเปิดใช้งาน)
    registerStore: publicProcedure
      .input(
        z.object({
          ownerName: z.string().min(1, "ชื่อผู้ใช้ต้องไม่ว่าง"),
          email: z.string().email("รูปแบบอีเมลไม่ถูกต้อง"),
          password: z.string().min(6, "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร"),
          storeName: z.string().min(1, "ชื่อร้านต้องไม่ว่าง").max(200),
          phone: z.string().max(50).optional(),
          address: z.string().max(500).optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        try {
          const emailLower = input.email.toLowerCase();
          const existing = await db.getUserByEmail(emailLower);
          if (existing) {
            throw new TRPCError({ code: "CONFLICT", message: "อีเมลนี้ถูกใช้งานแล้ว" });
          }

          const owner = await db.createInternalUser({
            name: input.ownerName,
            email: emailLower,
            password: input.password,
            role: "admin",
          });

          const now = new Date();
          const store = await db.createStore({
            storeCode: "STORE-" + Date.now(),
            name: input.storeName.trim(),
            ownerId: owner.id,
            subscriptionStatus: "pending",
            subscriptionPlan: "basic",
            requestedAt: now,
          });

          // ผูกผู้ใช้กับร้าน (owner/admin) — organizationId = null (owner)
          const users = await db.getCollectionAsync<db.UserDoc>("users");
          await users.updateOne(
            { id: owner.id },
            { $set: { storeId: store.id, role: "admin", organizationId: null, updatedAt: now } },
          );

          // Login อัตโนมัติ
          try {
            const sessionToken = await sdk.createSessionToken(owner.openId, {
              name: owner.name || "",
              role: "admin",
            });
            const cookieOptions = getSessionCookieOptions(ctx.req);
            ctx.res.cookie(COOKIE_NAME, sessionToken, {
              ...cookieOptions,
              maxAge: ONE_YEAR_MS,
            });
          } catch (tokenError) {
            console.error("[RegisterStore] Failed to create session token:", tokenError);
          }

          return {
            success: true,
            message: "สมัครร้านสำเร็จ (สถานะ: pending) รอการอนุมัติจากผู้ดูแลระบบ",
            storeId: store.id,
            status: "pending",
          } as const;
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          const msg = error instanceof Error ? error.message : String(error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `สมัครร้านไม่สำเร็จ: ${msg}` });
        }
      }),
    login: publicProcedure
      .input(
        z.object({
          email: z.string().email("รูปแบบอีเมลไม่ถูกต้อง"),
          password: z.string().min(6, "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร"),
        })
      )
      .mutation(async ({ input, ctx }) => {
        console.log("[Login] Attempting login for:", input.email);
        const user = await db.getUserByEmail(input.email);
        if (!user) {
          console.log("[Login] User not found:", input.email);
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
          });
        }
        console.log("[Login] User found:", { id: user.id, email: user.email, hasPassword: !!user.passwordHash });
        if (!user.passwordHash || !user.passwordSalt) {
          console.log("[Login] User has no password set");
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "บัญชีนี้ไม่ได้ตั้งรหัสผ่าน กรุณาติดต่อผู้ดูแลระบบ",
          });
        }
        const passwordValid = db.verifyUserPassword(user, input.password);
        console.log("[Login] Password verification result:", passwordValid);
        if (!passwordValid) {
          console.log("[Login] Invalid password for:", input.email);
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
          });
        }
        console.log("[Login] Login successful for:", input.email);

        const effectiveRole = user.role === "superadmin" || isSuperAdminEmail(user.email) ? "superadmin" : user.role;
        const sessionToken = await sdk.createSessionToken(user.openId, {
          name: user.name || "",
          role: effectiveRole, // ฝัง role ใน token
        });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, sessionToken, {
          ...cookieOptions,
          maxAge: ONE_YEAR_MS,
        });
        await db.upsertUser({
          openId: user.openId,
          lastSignedIn: new Date(),
        });
        return { 
          success: true,
          role: effectiveRole, // ส่ง role กลับไปใน response
          name: user.name,
          email: user.email,
        } as const;
      }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
    redeemAdminCode: protectedProcedure
      .input(z.object({ code: z.string().min(1, "กรุณากรอกรหัสแอดมิน") }))
      .mutation(async ({ input, ctx }) => {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "ระบบเข้าร้านด้วยรหัสแอดมินถูกปิดใช้งาน (กรุณาใช้การสมัครร้านแทน)",
        });
      }),
  }),

  // ============ ADMIN CODES (ระบบสร้างรหัสแอดมิน - ใช้รหัสหลักเข้าถึง) ============
  adminCodes: router({
    // ตรวจสอบว่าผ่านรหัสหลักแล้ว (มี session)
    checkAccess: publicProcedure.query(async ({ ctx }) => {
      return { allowed: false };
    }),
    // กรอกรหัสหลัก เพื่อเข้าสู่ระบบสร้างรหัสแอดมิน (ตั้ง ORDERA_MASTER_CODE ใน env.runtime)
    verifyAccess: publicProcedure
      .input(z.object({ code: z.string().min(1, "กรุณากรอกรหัส") }))
      .mutation(async ({ input, ctx }) => {
        throw new TRPCError({ code: "FORBIDDEN", message: "ระบบสร้างรหัสแอดมินถูกปิดใช้งาน" });
      }),
    // สร้างรหัสแอดมิน (ต้อง verifyAccess ผ่านก่อน)
    createCode: publicProcedure.mutation(async ({ ctx }) => {
      throw new TRPCError({ code: "FORBIDDEN", message: "ระบบสร้างรหัสแอดมินถูกปิดใช้งาน" });
    }),
    // ออกจากระบบสร้างรหัส (ล้าง session)
    clearAccess: publicProcedure.mutation(({ ctx }) => {
      return { success: true };
    }),
  }),

  // ============ SUBSCRIPTION / STORE ACCESS ============
  subscription: router({
    my: protectedProcedure.query(async ({ ctx }) => {
      const storeId = ctx.user?.storeId ?? null;
      if (!storeId) {
        return { storeId: null, status: "disabled", expiresAt: null, subscriptionPlan: "premium" } as const;
      }
      const ownerId = db.getUserOrganizationId(ctx.user);
      if (!ownerId) {
        return { storeId: Number(storeId), status: "disabled", expiresAt: null, subscriptionPlan: "premium" } as const;
      }
      return db.getStoreSubscriptionForOrgStore(Number(storeId), Number(ownerId));
    }),
  }),

  // ============ SUPER ADMIN (คุมร้านทั้งหมด + Subscription) ============
  superAdmin: router({
    // ยืนยันรหัสผ่านทุกครั้งก่อนเข้าแดชบอร์ด (ไม่เก็บ/ไม่จำรหัส)
    verifyPassword: superAdminProcedure
      .input(z.object({ password: z.string().min(6).max(200) }))
      .mutation(async ({ input, ctx }) => {
        const openId = (ctx.user as any)?.openId;
        if (!openId) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "กรุณาเข้าสู่ระบบใหม่" });
        }
        const row = await db.getUserByOpenId(String(openId));
        if (!row) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "กรุณาเข้าสู่ระบบใหม่" });
        }
        const ok = db.verifyUserPassword(row, input.password);
        if (!ok) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "รหัสผ่านไม่ถูกต้อง" });
        }
        return { success: true } as const;
      }),
    stores: router({
      list: superAdminProcedure.query(async () => {
        // NOTE: หลีกเลี่ยงการคำนวณด้วย store.id เพราะในข้อมูลจริงอาจมี id ซ้ำ
        // ให้คำนวณสถานะจาก doc + storeCode (ซึ่งมนุษย์ใช้อ้างอิงจริง)
        return db.listAllStoresForSuperAdmin();
      }),
      update: superAdminProcedure
        .input(
          z.object({
            storeCode: z.string().min(1),
            subscriptionStatus: z.enum(["pending", "active", "disabled", "expired"]).optional(),
            subscriptionPlan: z.enum(["basic", "premium"]).optional(),
            expiresAt: z.union([z.string(), z.null()]).optional(), // accept ISO or YYYY-MM-DD or null
            disabledReason: z.union([z.string().max(500), z.null()]).optional(),
          }),
        )
        .mutation(async ({ input }) => {
          const expiresAt =
            input.expiresAt === undefined
              ? undefined
              : input.expiresAt === null || String(input.expiresAt).trim() === ""
                ? null
                : new Date(String(input.expiresAt));

          if (expiresAt instanceof Date && !Number.isFinite(expiresAt.getTime())) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "รูปแบบวันหมดอายุไม่ถูกต้อง" });
          }

          return db.updateStoreSubscriptionByCode(input.storeCode, {
            subscriptionStatus: input.subscriptionStatus,
            subscriptionPlan: input.subscriptionPlan,
            expiresAt: expiresAt as Date | null | undefined,
            disabledReason: input.disabledReason ?? undefined,
          });
        }),
      delete: superAdminProcedure
        .input(
          z.object({
            storeCode: z.string().min(1),
            confirm: z.string().min(1),
          }),
        )
        .mutation(async ({ input }) => {
          const code = input.storeCode.trim();
          const expected = `DELETE ${code}`;
          if (input.confirm.trim() !== expected) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `กรุณาพิมพ์ยืนยันให้ตรง: ${expected}`,
            });
          }
          return deleteStoreAndOrgDataByStoreCode(code);
        }),
    }),
  }),

  // ============ CATEGORIES ============
  categories: router({
    list: posProcedure.query(async ({ ctx }) => {
      const orgId = db.getUserOrganizationId(ctx.user);
      return db.getCategories(orgId);
    }),
    
    get: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const orgId = ctx.user ? db.getUserOrganizationId(ctx.user) : null;
        return db.getCategoryById(input.id, orgId);
      }),
    
    create: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          displayOrder: z.number().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        if (!orgId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "ไม่พบข้อมูล organization",
          });
        }
        try {
          return await db.createCategory({ ...input, organizationId: orgId });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("ID ซ้ำ")) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "ไม่สามารถสร้างหมวดหมู่ได้ เนื่องจาก ID ซ้ำ",
            });
          }
          throw e;
        }
      }),
    
    update: managerProcedure // Manager และ Admin แก้ไขได้
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          description: z.string().optional(),
          displayOrder: z.number().optional(),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.updateCategory(id, data, orgId);
      }),

    delete: managerProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        await db.deleteCategory(input.id, orgId);
        return { success: true };
      }),

    fixDuplicateIds: managerProcedure.mutation(async () => {
      return db.fixDuplicateCategoryIds();
    }),
  }),

  // ============ PRODUCTS ============
  products: router({
    list: posProcedure
      .input(
        z.object({
          categoryId: z.number().optional(),
          search: z.string().optional(),
        })
      )
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.getProducts({ ...input, organizationId: orgId });
      }),

    get: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const orgId = ctx.user ? db.getUserOrganizationId(ctx.user) : null;
        return db.getProductById(input.id, orgId);
      }),

    getBySku: publicProcedure
      .input(z.object({ sku: z.string() }))
      .query(async ({ input, ctx }) => {
        const orgId = ctx.user ? db.getUserOrganizationId(ctx.user) : null;
        return db.getProductBySku(input.sku, orgId);
      }),

    /** สแกน QR/Barcode: คืน product หรือ scale (productCode|weight|totalPrice) */
    lookupByScan: posProcedure
      .input(z.object({ code: z.string() }))
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.lookupProductByScan(input.code.trim(), orgId);
      }),

    create: protectedProcedure
      .input(
        z.object({
          sku: z.string().min(1),
          name: z.string().min(1).refine((n) => !/^\d+$/.test(n.trim()), { message: "ชื่อสินค้าต้องอ่านรู้เรื่อง ห้ามเป็นตัวเลขล้วน" }),
          description: z.string().optional(),
          categoryId: z.number(),
          price: z.string(),
          cost: z.string().optional(),
          imageUrl: z.string().nullable().optional(),
          barcode: z.string().nullable().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        try {
          console.log("[products.create] User:", ctx.user ? { id: ctx.user.id, email: ctx.user.email } : "null");
          if (!ctx.user) {
            throw new TRPCError({
              code: "UNAUTHORIZED",
              message: "กรุณาเข้าสู่ระบบก่อน",
            });
          }
          const orgId = db.getUserOrganizationId(ctx.user);
          if (!orgId) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "ไม่พบข้อมูล organization",
            });
          }
          // SKU ต้องไม่ซ้ำในร้านเดียว
          const existingBySku = await db.getProductBySku(input.sku.trim(), orgId);
          if (existingBySku) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `SKU "${input.sku}" ถูกใช้งานแล้วในร้านนี้`,
            });
          }
          // บาร์โค้ดต้องไม่ซ้ำทั้งระบบ (ใน org เดียวกัน)
          if (input.barcode && input.barcode.trim()) {
            const existingByBarcode = await db.getProductByBarcode(input.barcode.trim(), orgId);
            if (existingByBarcode) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "บาร์โค้ดนี้ถูกใช้งานแล้วโดยสินค้าอื่น",
              });
            }
          }
          const result = await db.createProduct({ ...input, organizationId: orgId });
          console.log("[products.create] Product created successfully:", result.id);
          return result;
        } catch (error) {
          console.error("[products.create] Error:", error);
          if (error instanceof TRPCError) {
            throw error;
          }
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `เกิดข้อผิดพลาดในการสร้างสินค้า: ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
          });
        }
      }),

    update: managerProcedure // Manager และ Admin แก้ไขได้
      .input(
        z.object({
          id: z.number(),
          sku: z.string().optional(),
          name: z.string().min(1).refine((n) => !/^\d+$/.test((n ?? "").trim()), { message: "ชื่อสินค้าต้องอ่านรู้เรื่อง ห้ามเป็นตัวเลขล้วน" }).optional(),
          description: z.string().optional(),
          categoryId: z.number().optional(),
          price: z.string().optional(),
          cost: z.string().optional(),
          imageUrl: z.string().nullable().optional(),
          barcode: z.string().nullable().optional(),
          status: z.enum(["active", "inactive"]).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        
        const orgId = db.getUserOrganizationId(ctx.user);
        if (data.sku) {
          const existingProduct = await db.getProductBySku(data.sku, orgId);
          if (existingProduct && existingProduct.id !== id) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `SKU "${data.sku}" ถูกใช้งานแล้วโดยสินค้าอื่น`,
            });
          }
        }
        if (data.barcode != null && String(data.barcode).trim()) {
          const existingByBarcode = await db.getProductByBarcode(String(data.barcode).trim(), orgId);
          if (existingByBarcode && existingByBarcode.id !== id) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "บาร์โค้ดนี้ถูกใช้งานแล้วโดยสินค้าอื่น",
            });
          }
        }
        return db.updateProduct(id, data, orgId);
      }),

    delete: managerProcedure // Manager และ Admin ลบได้
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        await db.deleteProduct(input.id, orgId);
        return { success: true };
      }),

    /** สร้างบาร์โค้ดใหม่จาก productId (admin only, ปุ่มแก้ฉุกเฉิน) */
    regenerateBarcode: adminProcedure
      .input(z.object({ productId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.regenerateProductBarcode(input.productId, orgId);
      }),

    /** แก้บาร์โค้ดซ้ำทั้งหมด: ล้างที่ซ้ำ → สร้างใหม่จาก productId (admin only) */
    fixDuplicateBarcodes: adminProcedure.mutation(async () => {
      return db.fixDuplicateBarcodes();
    }),

    /** หา product ที่ id ซ้ำในร้าน (ถ้ามี = สต็อกแสดงเท่ากันทั้งสองตัว) */
    findDuplicateProductIds: adminProcedure
      .input(z.object({}).optional())
      .query(async ({ ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        if (!orgId) return [];
        return db.findDuplicateProductIds(orgId);
      }),

    /** แก้ product id ซ้ำ: ให้สินค้าที่ซ้ำได้ id ใหม่และแถว inventory แยก (กันสต็อกลดทั้งสองตัว) */
    fixDuplicateProductIds: adminProcedure.mutation(async ({ ctx }) => {
      const orgId = db.getUserOrganizationId(ctx.user);
      if (!orgId) throw new TRPCError({ code: "BAD_REQUEST", message: "ไม่พบ organization" });
      return db.fixDuplicateProductIds(orgId);
    }),
  }),

  // ============ CUSTOMERS ============
  customers: router({
    list: posProcedure
      .input(
        z.object({
          search: z.string().optional(),
        }).optional()
      )
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        const searchTerm = input?.search;
        return db.getCustomers(searchTerm, orgId);
      }),

    get: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(({ input }) => db.getCustomerById(input.id)),

    create: protectedProcedure
      .input(
        z.object({
          id: z.number().optional(), // ID ที่กำหนดเอง (optional)
          name: z.string().min(1),
          phone: z.string().optional(),
          email: z.union([z.string().email(), z.literal("")]).optional(),
          address: z.string().optional(),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        console.log("[customers.create] Input:", input);
        const orgId = db.getUserOrganizationId(ctx.user);
        console.log("[customers.create] Organization ID:", orgId);
        if (!orgId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "ไม่พบข้อมูล organization",
          });
        }
        try {
          // ถ้า email เป็น empty string ให้แปลงเป็น undefined
          const email = input.email === "" ? undefined : input.email;
          
          // ถ้ามี ID ที่กำหนดมา ตรวจสอบว่าไม่ซ้ำ
          if (input.id !== undefined) {
            const existingCustomer = await db.getCustomerById(input.id, orgId);
            if (existingCustomer) {
              throw new TRPCError({
                code: "CONFLICT",
                message: `ID ${input.id} ถูกใช้งานแล้วโดยลูกค้า: ${existingCustomer.name}`,
              });
            }
          }
          
          const result = await db.createCustomer({ 
            ...input, 
            email,
            organizationId: orgId 
          });
          console.log("[customers.create] Customer created:", result.id);
          return result;
        } catch (error) {
          console.error("[customers.create] Error:", error);
          if (error instanceof TRPCError) {
            throw error;
          }
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `เกิดข้อผิดพลาดในการสร้างลูกค้า: ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
          });
        }
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().min(1).optional(),
          phone: z.string().optional(),
          email: z.union([z.string().email(), z.literal("")]).optional(),
          address: z.string().optional(),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        // ถ้า email เป็น empty string ให้แปลงเป็น undefined
        if (data.email === "") {
          data.email = undefined;
        }
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.updateCustomer(id, data, orgId);
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        await db.deleteCustomer(input.id, orgId);
        return { success: true };
      }),
  }),

  // ============ TRANSACTIONS ============
  transactions: router({
    create: posProcedure
      .input(
        z.object({
          transactionNumber: z.string(),
          customerId: z.number().optional(),
          subtotal: z.string(),
          tax: z.string(),
          discount: z.string(),
          total: z.string(),
          paymentMethod: z.enum(["cash", "transfer", "card", "ewallet", "mixed"]),
          items: z.array(
            z.object({
              productId: z.number(),
              quantity: z.number(),
              unitPrice: z.string(),
              discount: z.string(),
              subtotal: z.string(),
              toppings: z.array(
                z.object({
                  id: z.number(),
                  name: z.string(),
                  price: z.number(),
                })
              ).optional(), // ท็อปปิ้งที่เลือก (optional)
            })
          ),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        if (!orgId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "ไม่พบข้อมูล organization",
          });
        }
        // ตรวจ payload: ทุกรายการต้องมี productId (ไม่มี = ระบบพัง)
        for (const item of input.items) {
          const pid = item.productId;
          if (pid == null || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "orderItems ทุกรายการต้องมี productId ที่ถูกต้อง (ตัวเลขจำนวนเต็มบวก)",
            });
          }
        }

        // ตัดสต็อกเฉพาะสินค้าที่อยู่ในบิล, ใช้ productId เท่านั้น, ห้ามใช้ storeId/sku รวม
        // 1 order item = 1 การตัดสต็อก — ไม่รวมรายการ; แต่ต้องตรวจสต็อกรวมต่อ productId ก่อน
        const qtyByProductId = new Map<number, number>();
        for (const item of input.items) {
          const pid = item.productId;
          const qty = Number(item.quantity) || 0;
          qtyByProductId.set(pid, (qtyByProductId.get(pid) ?? 0) + qty);
        }
        for (const [productId, totalQty] of qtyByProductId) {
          const inv = await db.getInventoryByProductId(productId, orgId);
          const current = Number(inv?.quantity ?? 0);
          if (current < totalQty) {
            const p = await db.getProductById(productId, orgId);
            const name = p?.name ?? `#${productId}`;
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `สินค้า "${name}" ไม่เพียงพอ (คงคลัง: ${current}, ต้องการ: ${totalQty})`,
            });
          }
        }

        // ถ้ามี customerId ให้ตรวจว่ามีอยู่จริงก่อนสร้างบิล (กันสร้างบิลหลอกแล้วค่อยมาพังทีหลัง)
        if (input.customerId) {
          const customer = await db.getCustomerById(input.customerId, orgId);
          if (!customer) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `ลูกค้าไม่พบ (ID: ${input.customerId})`,
            });
          }
        }

        // 1. สร้างบิล 2. ชำระเงินสำเร็จ (transaction = บันทึกบิล) 3. ตัดสต็อก — ห้ามตัดตอนเพิ่มเข้าตะกร้า/ยิงบาร์โค้ด
        const cashierName = ctx.user.name || `User #${ctx.user.id}`;
        const transaction = await db.createTransaction({
          transactionNumber: input.transactionNumber,
          cashierId: ctx.user.id,
          cashierName: cashierName,
          customerId: input.customerId,
          subtotal: input.subtotal,
          tax: input.tax,
          discount: input.discount,
          total: input.total,
          paymentMethod: input.paymentMethod,
          notes: input.notes,
          organizationId: orgId,
        });

        const transactionId = (transaction as any).id;
        console.log("[transactions.create] Transaction created with ID:", transactionId);

        // สร้าง order items (หนึ่งแถวต่อรายการในบิล — สำหรับใบเสร็จ)
        for (const item of input.items) {
          const productId = item.productId;
          const quantity = Number(item.quantity) || 0;
          if (quantity <= 0) continue;
          const p = await db.getProductById(productId, orgId);
          const productName = p?.name ?? `#${productId}`;
          await db.createTransactionItem({
            transactionId,
            productId,
            productName,
            quantity,
            unitPrice: item.unitPrice,
            discount: item.discount,
            subtotal: String(parseFloat(item.subtotal || "0").toFixed(2)),
            toppings: item.toppings || [],
          });
        }

        // ตัดสต็อกหลังชำระเงินสำเร็จ — รวม qty ต่อ productId แล้วตัดครั้งเดียวต่อสินค้า (กันลดซ้ำสองอัน)
        const deductByProductId = new Map<number, number>();
        for (const item of input.items) {
          const pid = item.productId;
          const qty = Number(item.quantity) || 0;
          if (qty <= 0) continue;
          deductByProductId.set(pid, (deductByProductId.get(pid) ?? 0) + qty);
        }
        for (const [productId, totalQty] of deductByProductId) {
          const inv = await db.getInventoryByProductId(productId, orgId);
          const currentQty = Number(inv?.quantity ?? 0);
          const newQty = currentQty - totalQty;
          console.log(`CUT_STOCK productId=${productId} qty=${totalQty}`);
          await db.updateInventory(productId, newQty, orgId);
          await db.recordStockMovement({
            productId,
            movementType: "out",
            quantity: totalQty,
            reason: `Sale - Transaction ${input.transactionNumber}`,
            userId: ctx.user.id,
          });
        }

        // สร้าง Tax Invoice อัตโนมัติถ้าร้านจด VAT และมีการคิด VAT จริง (tax > 0)
        const companyProfile = await db.getCompanyProfile(orgId);
        const vatAmount = parseFloat(input.tax || "0");
        if (companyProfile?.vatRegistered && vatAmount > 0) {
          const subtotal = parseFloat(input.subtotal || "0");
          const vat = vatAmount;
          const total = parseFloat(input.total || "0");
          
          // ดึงข้อมูลลูกค้า (ถ้ามี)
          let customerName = "ลูกค้าเงินสด";
          let customerTaxId: string | undefined;
          let customerAddress: string | undefined;
          
          if (input.customerId) {
            const customer = await db.getCustomerById(input.customerId, orgId);
            if (customer) {
              customerName = customer.name || "ลูกค้าเงินสด";
              customerTaxId = (customer as any).taxId;
              customerAddress = customer.address;
            }
          }

          // สร้างเลขที่ใบกำกับภาษี (IV + ปี + เดือน + ลำดับ)
          const now = new Date();
          const year = now.getFullYear();
          const month = String(now.getMonth() + 1).padStart(2, "0");
          const invoiceSeq = await db.getNextSeq(`taxInvoices-${year}${month}`);
          const invoiceNo = `IV${year}${month}-${String(invoiceSeq).padStart(4, "0")}`;

          // สร้าง tax invoice (ใช้แบบย่อถ้าไม่มีเลขผู้เสียภาษีลูกค้า)
          const invoiceType = customerTaxId ? "full" : "abbreviated";
          
          await db.createTaxInvoice({
            invoiceNo,
            invoiceType,
            transactionId,
            date: now,
            customerName,
            customerTaxId,
            customerAddress,
            subtotal,
            vat,
            total,
          }, orgId);
        }

        if (input.customerId) {
          // เพิ่มคะแนนสะสมให้ลูกค้า
          const settings = await db.getLoyaltySettings();
          console.log("[transactions.create] ========== LOYALTY POINTS PROCESSING ==========");
          console.log("[transactions.create] Customer ID received:", input.customerId);
          console.log("[transactions.create] Customer ID type:", typeof input.customerId);
          
          // ตรวจสอบว่าลูกค้ามีอยู่จริง
          const orgId = db.getUserOrganizationId(ctx.user);
          const customer = await db.getCustomerById(input.customerId, orgId);
          if (!customer) {
            console.error("[transactions.create] ❌ Customer not found:", input.customerId);
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `ลูกค้าไม่พบ (ID: ${input.customerId})`,
            });
          }
          
          console.log("[transactions.create] Customer found:", {
            id: customer.id,
            name: customer.name,
            email: customer.email,
            currentPoints: customer.loyaltyPoints || 0
          });
          
          console.log("[transactions.create] Loyalty settings:", settings);
          
          if (settings?.isActive) {
            // คำนวณคะแนนตามการตั้งค่า
            // ถ้า pointsPerBaht = 100 หมายความว่า 100 บาทต่อ 1 คะแนน
            // สูตร: คะแนน = ยอดซื้อ / pointsPerBaht
            const pointsPerBahtRaw = settings.pointsPerBaht?.toString() || "1";
            let pointsPerBaht = parseFloat(pointsPerBahtRaw);
            
            // ถ้า pointsPerBaht เป็น 0 หรือติดลบ ให้ใช้ค่า default
            if (pointsPerBaht <= 0) {
              pointsPerBaht = 1;
            }
            
            // คะแนนควรคำนวณจากยอดรวมก่อนหักส่วนลด (subtotal) 
            // เพื่อให้ลูกค้าได้คะแนนตามยอดซื้อจริง ไม่ใช่ยอดหลังหักส่วนลด
            const subtotalAmount = parseFloat(input.subtotal || "0");
            
            console.log("[transactions.create] Transaction amounts:", {
              subtotal: input.subtotal,
              discount: input.discount,
              tax: input.tax,
              total: input.total,
              subtotalAmount,
            });
            
            // คำนวณคะแนน: ยอดซื้อ / pointsPerBaht
            // ตัวอย่าง: ถ้า pointsPerBaht = 100 และ subtotal = 250
            // คะแนน = 250 / 100 = 2.5 → Math.floor = 2 คะแนน
            const points = Math.floor(subtotalAmount / pointsPerBaht);
            
            console.log("[transactions.create] Calculating loyalty points:", {
              subtotalAmount,
              pointsPerBahtRaw,
              pointsPerBaht,
              formula: `${subtotalAmount} / ${pointsPerBaht}`,
              points,
              customerId: input.customerId,
              customerName: customer.name
            });
            
            if (points > 0) {
              console.log("[transactions.create] Calling addLoyaltyPoints for customer:", {
                customerId: input.customerId,
                customerName: customer.name,
                points
              });
              await db.addLoyaltyPoints(
                input.customerId,
                points,
                `Earned from transaction ${input.transactionNumber} (${subtotalAmount.toFixed(2)} บาท / ${pointsPerBaht} บาทต่อคะแนน)`,
                transactionId,
                orgId
              );
              console.log("[transactions.create] ✅ Loyalty points added successfully");
            } else {
              console.log("[transactions.create] ⚠️ No points to add (points = 0)");
            }
          } else {
            console.log("[transactions.create] ⚠️ Loyalty program is not active");
          }
          
          // อัปเดตยอดซื้อรวมของลูกค้า
          const currentTotalSpent = parseFloat(customer.totalSpent || "0");
          const newTotalSpent = currentTotalSpent + parseFloat(input.total || "0");
          await db.updateCustomer(input.customerId, {
            totalSpent: newTotalSpent.toFixed(2),
          }, orgId);
          console.log("[transactions.create] ✅ Customer totalSpent updated:", {
            customerId: input.customerId,
            customerName: customer.name,
            oldTotalSpent: currentTotalSpent,
            newTotalSpent
          });
          console.log("[transactions.create] ========== END LOYALTY POINTS PROCESSING ==========");
        } else {
          console.log("[transactions.create] ⚠️ No customerId provided, skipping loyalty points");
        }

        return transaction;
      }),
    
    get: adminProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const orgId = ctx.user ? db.getUserOrganizationId(ctx.user) : null;
        return db.getTransactionById(input.id, orgId);
      }),
    
    getByDateRange: adminProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
        })
      )
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.getTransactionsByDateRange(input.startDate, input.endDate, orgId);
      }),
    
    getItems: adminProcedure
      .input(z.object({ transactionId: z.number() }))
      .query(({ input }) => db.getTransactionItems(input.transactionId)),
  }),

  // ============ INVENTORY ============
  inventory: router({
    list: protectedProcedure
      .input(
        z.object({
          search: z.string().optional(),
        }).optional()
      )
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.getInventoryList(input?.search, orgId);
      }),
    
    adjustStock: protectedProcedure
      .input(
        z.object({
          productId: z.number(),
          quantity: z.number(),
          type: z.enum(["in", "out", "adjustment"]),
          reason: z.string().min(1, "กรุณากรอกเหตุผล"),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        if (orgId == null) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "ไม่พบข้อมูล organization",
          });
        }
        const inv = await db.getInventoryByProductId(input.productId, orgId);
        const current = Number(inv?.quantity ?? 0) || 0;
        let newQty: number;
        if (input.type === "in") {
          newQty = current + input.quantity;
        } else if (input.type === "out") {
          newQty = current - input.quantity;
          if (newQty < 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `ห้ามสต็อกติดลบ (คงคลังปัจจุบัน: ${current}, ลด: ${input.quantity})`,
            });
          }
        } else {
          newQty = input.quantity;
          if (newQty < 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "ห้ามสต็อกติดลบ",
            });
          }
        }
        await db.updateInventory(input.productId, newQty, orgId);
        await db.recordStockMovement({
          productId: input.productId,
          movementType: input.type,
          quantity: input.type === "out" ? input.quantity : input.type === "in" ? input.quantity : newQty,
          reason: input.reason,
          userId: ctx.user.id,
        });
        return { success: true, newQuantity: newQty };
      }),
    
    getMovementHistory: protectedProcedure
      .input(z.object({ productId: z.number() }))
      .query(({ input }) => db.getStockMovementHistory(input.productId)),
  }),

  // ============ ACTIVITY LOGS ============
  activityLogs: router({
    list: adminProcedure
      .input(
        z.object({
          userId: z.number().optional(),
          limit: z.number().optional(),
        })
      )
      .query(({ input }) =>
        db.getActivityLogs(input.userId, input.limit ?? 100)
      ),
  }),

  // ============ REPORTS ============
  reports: router({
    salesByDateRange: reportsProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
          paymentMethod: z.string().optional(),
          transactionNumberSearch: z.string().optional(),
        })
      )
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        const start = new Date(input.startDate);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(input.endDate);
        end.setUTCHours(23, 59, 59, 999);
        let transactions = await db.getTransactionsByDateRange(
          start,
          end,
          orgId
        );
        const rid = (ctx as { reportRestrictCashierId?: number }).reportRestrictCashierId;
        if (rid != null) transactions = transactions.filter((t) => parseInt(String(t.cashierId), 10) === rid);
        if (input.paymentMethod && input.paymentMethod !== "all") transactions = transactions.filter((t) => (t.paymentMethod || "") === input.paymentMethod);
        if (input.transactionNumberSearch?.trim()) {
          const q = input.transactionNumberSearch.trim().toLowerCase();
          transactions = transactions.filter((t) => (t.transactionNumber || "").toLowerCase().includes(q));
        }
        // IMPORTANT: นับเฉพาะ "บิลจริง" ที่มีรายการสินค้าใน transactionItems อย่างน้อย 1 แถว
        const ids = transactions.map((t) => Number(t.id)).filter((n) => Number.isFinite(n));
        const hasItems = await db.getTransactionIdsWithAnyItems(ids);
        transactions = transactions.filter((t) => hasItems.has(Number(t.id)));
        // จำนวนบิล = นับจาก orders เท่านั้น (ห้ามนับจาก items)
        const totalSales = transactions.reduce(
          (sum, t) => sum + parseFloat(t.total || "0"),
          0
        );
        const totalTax = transactions.reduce(
          (sum, t) => sum + parseFloat(t.tax || "0"),
          0
        );
        const totalDiscount = transactions.reduce(
          (sum, t) => sum + parseFloat(t.discount || "0"),
          0
        );

        return {
          totalTransactions: transactions.length, // จำนวนบิล = นับจาก orders เท่านั้น
          totalSales,
          totalTax,
          totalDiscount,
          transactions,
        };
      }),
    
    topProducts: reportsProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
          limit: z.number().optional(),
        })
      )
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        const rid = (ctx as { reportRestrictCashierId?: number }).reportRestrictCashierId;
        const start = new Date(input.startDate);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(input.endDate);
        end.setUTCHours(23, 59, 59, 999);
        return db.getTopSellingProducts(
          start,
          end,
          input.limit ?? 10,
          orgId,
          rid ?? undefined
        );
      }),
    
    salesByPaymentMethod: adminProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
        })
      )
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        const start = new Date(input.startDate);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(input.endDate);
        end.setUTCHours(23, 59, 59, 999);
        let transactions = await db.getTransactionsByDateRange(
          start,
          end,
          orgId
        );
        const ids = transactions.map((t) => Number(t.id)).filter((n) => Number.isFinite(n));
        const hasItems = await db.getTransactionIdsWithAnyItems(ids);
        transactions = transactions.filter((t) => hasItems.has(Number(t.id)));
        
        const paymentMethods: Record<string, { count: number; total: number }> = {};
        
        transactions.forEach((t) => {
          const method = t.paymentMethod || "unknown";
          if (!paymentMethods[method]) {
            paymentMethods[method] = { count: 0, total: 0 };
          }
          paymentMethods[method].count += 1;
          paymentMethods[method].total += parseFloat(t.total || "0");
        });

        return paymentMethods;
      }),
    
    dailySales: reportsProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
        })
      )
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        const start = new Date(input.startDate);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(input.endDate);
        end.setUTCHours(23, 59, 59, 999);
        let transactions = await db.getTransactionsByDateRange(start, end, orgId);
        const rid = (ctx as { reportRestrictCashierId?: number }).reportRestrictCashierId;
        if (rid != null) transactions = transactions.filter((t) => parseInt(String(t.cashierId), 10) === rid);
        const ids = transactions.map((t) => Number(t.id)).filter((n) => Number.isFinite(n));
        const hasItems = await db.getTransactionIdsWithAnyItems(ids);
        transactions = transactions.filter((t) => hasItems.has(Number(t.id)));
        const dailySales: Record<string, { count: number; total: number }> = {};
        transactions.forEach((t) => {
          const date = new Date(t.createdAt).toISOString().split("T")[0];
          if (!dailySales[date]) {
            dailySales[date] = { count: 0, total: 0 };
          }
          dailySales[date].count += 1;
          dailySales[date].total += parseFloat(t.total || "0");
        });

        return dailySales;
      }),
    
    exportSalesReport: reportsProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
          format: z.enum(["pdf", "excel"]),
        })
      )
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        const start = new Date(input.startDate);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(input.endDate);
        end.setUTCHours(23, 59, 59, 999);
        let transactions = await db.getTransactionsByDateRange(start, end, orgId);
        const rid = (ctx as { reportRestrictCashierId?: number }).reportRestrictCashierId;
        if (rid != null) transactions = transactions.filter((t) => parseInt(String(t.cashierId), 10) === rid);
        const ids = transactions.map((t) => Number(t.id)).filter((n) => Number.isFinite(n));
        const hasItems = await db.getTransactionIdsWithAnyItems(ids);
        transactions = transactions.filter((t) => hasItems.has(Number(t.id)));
        
        const totalSales = transactions.reduce(
          (sum, t) => sum + parseFloat(t.total || "0"),
          0
        );
        const totalTax = transactions.reduce(
          (sum, t) => sum + parseFloat(t.tax || "0"),
          0
        );
        const totalDiscount = transactions.reduce(
          (sum, t) => sum + parseFloat(t.discount || "0"),
          0
        );

        const reportData = {
          startDate: input.startDate,
          endDate: input.endDate,
          totalTransactions: transactions.length,
          totalSales,
          totalTax,
          totalDiscount,
          transactions,
          format: input.format,
        };

        return reportData;
      }),

    /**
     * ประวัติการขายแยกตามพนักงาน – ดูได้ว่าสินค้า/อาหารแต่ละชิ้น พนักงานคนไหนเป็นคนขาย
     * ใช้ cashierId ของ transaction (พนักงานที่กดชำระเงิน = คนขายทั้งบิล)
     * Admin/Manager: ดูทั้งหมด; Cashier: เฉพาะบิลของตัวเอง
     */
    salesAudit: reportsProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
          cashierId: z.number().optional(),
          productId: z.number().optional(),
          paymentMethod: z.string().optional(),
          transactionNumberSearch: z.string().optional(),
          viewMode: z.enum(["bills", "items"]).optional().default("items"), // "bills" = ระดับบิล, "items" = ระดับรายการ
        })
      )
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        if (!orgId) return { rows: [] };

        const rid = (ctx as { reportRestrictCashierId?: number }).reportRestrictCashierId;
        const effectiveCashierId = rid != null ? rid : input.cashierId;

        const start = new Date(input.startDate);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(input.endDate);
        end.setUTCHours(23, 59, 59, 999);
        let transactions = await db.getTransactionsByDateRange(
          start,
          end,
          orgId
        );

        if (effectiveCashierId != null) {
          transactions = transactions.filter(
            (t) => parseInt(String(t.cashierId), 10) === effectiveCashierId
          );
        }
        if (input.paymentMethod && input.paymentMethod !== "all") {
          transactions = transactions.filter((t) => (t.paymentMethod || "") === input.paymentMethod);
        }
        if (input.transactionNumberSearch?.trim()) {
          const q = input.transactionNumberSearch.trim().toLowerCase();
          transactions = transactions.filter((t) => (t.transactionNumber || "").toLowerCase().includes(q));
        }
        // ตัดบิลหลอก (ไม่มีรายการสินค้า)
        const ids = transactions.map((t) => Number(t.id)).filter((n) => Number.isFinite(n));
        const hasItems = await db.getTransactionIdsWithAnyItems(ids);
        transactions = transactions.filter((t) => hasItems.has(Number(t.id)));

        // ใช้ cashierName จาก transaction โดยตรง (ไม่ต้อง JOIN users - ป้องกันชื่อเปลี่ยน)
        // ถ้า transaction เก่ายังไม่มี cashierName ให้ fallback ไป JOIN (backward compatibility)
        const cashierIds = Array.from(new Set(transactions.map((t) => String(t.cashierId))));
        const cashierMap: Record<string, string> = {};
        for (const idStr of cashierIds) {
          // ตรวจสอบว่ามี transaction ที่มี cashierName แล้วหรือยัง
          const txWithName = transactions.find((t) => String(t.cashierId) === idStr && (t as any).cashierName);
          if (txWithName) {
            cashierMap[idStr] = (txWithName as any).cashierName;
          } else {
            // Fallback: JOIN จาก users (สำหรับ transaction เก่า)
            const u = await db.getUserById(parseInt(idStr, 10), orgId);
            cashierMap[idStr] = u?.name ?? `ID: ${idStr}`;
          }
        }

        // โหมด "bills" = ตารางบิลขาย (1 บิล = 1 แถว) — ใช้ข้อมูลจาก orders เท่านั้น ไม่ใช้ $unwind
        if (input.viewMode === "bills") {
          const transactionIds = transactions.map((t) => t.id);
          // จำนวนรายการในบิล = items.length (จำนวนแถวใน transactionItems) ไม่ใช่ sum(quantity)
          const lineCountByTx = await db.getTransactionLineCounts(transactionIds);

          const rows = transactions
            .map((t) => {
              const txCashierName = (t as any).cashierName || cashierMap[String(t.cashierId)] || `ID: ${t.cashierId}`;
              const lineCount = lineCountByTx[t.id] ?? 0;
              return {
                transactionId: t.id,
                transactionNumber: t.transactionNumber ?? "",
                createdAt: t.createdAt,
                cashierId: String(t.cashierId),
                cashierName: txCashierName,
                paymentMethod: t.paymentMethod ?? "",
                lineCount, // จำนวนรายการในบิล = items.length
                total: t.total || "0", // ยอดรวมบิลจาก orders เท่านั้น
              };
            })
            .filter((r) => (r.lineCount ?? 0) > 0)
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            );

          return { rows };
        }

        // โหมด "items" = รายงานระดับรายการ (1 item = 1 row) - โค้ดเดิม
        const allItems: Array<{
          transactionId: number;
          transactionNumber: string;
          createdAt: Date;
          cashierId: string;
          cashierName: string;
          paymentMethod: string;
          transactionTotal: string;
          productId: number;
          productName: string;
          quantity: number;
          unitPrice: string;
          subtotal: string;
        }> = [];

        for (const t of transactions) {
          const items = await db.getTransactionItems(t.id);
          const txCashierName = (t as any).cashierName || cashierMap[String(t.cashierId)] || `ID: ${t.cashierId}`;
          for (const item of items) {
            if (
              input.productId != null &&
              Number(item.productId) !== input.productId
            )
              continue;
            const rawName = (item as any).productName;
            const productName = rawName?.trim() ? rawName : `#${item.productId}`;
            allItems.push({
              transactionId: t.id,
              transactionNumber: t.transactionNumber ?? "",
              createdAt: t.createdAt,
              cashierId: String(t.cashierId),
              cashierName: txCashierName,
              paymentMethod: t.paymentMethod ?? "",
              transactionTotal: t.total || "0",
              productId: Number(item.productId),
              productName,
              quantity: item.quantity,
              unitPrice: item.unitPrice ?? "0",
              subtotal: item.subtotal ?? "0",
            });
          }
        }

        // เติมชื่อสินค้าจาก products เมื่อบิลเก่าไม่มี productName (กันแสดง "#1" หลายแถว)
        const missingNames = new Set<number>();
        for (const i of allItems) {
          if (i.productName === `#${i.productId}`) missingNames.add(i.productId);
        }
        const productNameById: Record<number, string> = {};
        for (const pid of missingNames) {
          const p = await db.getProductById(pid, orgId);
          productNameById[pid] = p?.name?.trim() ? p.name : `#${pid}`;
        }
        for (const i of allItems) {
          if (i.productName === `#${i.productId}` && productNameById[i.productId]) {
            i.productName = productNameById[i.productId];
          }
        }

        const rows = allItems
          .map((i) => ({
            transactionId: i.transactionId,
            transactionNumber: i.transactionNumber,
            createdAt: i.createdAt,
            productId: i.productId,
            productName: i.productName,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            subtotal: i.subtotal,
            transactionTotal: i.transactionTotal,
            cashierId: i.cashierId,
            cashierName: i.cashierName,
            paymentMethod: i.paymentMethod,
          }))
          .sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );

        return { rows };
      }),

    /** สรุปรายพนักงาน: จำนวนบิล ยอดรวม เวลาเริ่ม-สิ้นสุด */
    staffPerformance: reportsProcedure
      .input(z.object({ startDate: z.date(), endDate: z.date() }))
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        const start = new Date(input.startDate);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(input.endDate);
        end.setUTCHours(23, 59, 59, 999);
        let transactions = await db.getTransactionsByDateRange(start, end, orgId);
        const rid = (ctx as { reportRestrictCashierId?: number }).reportRestrictCashierId;
        if (rid != null) transactions = transactions.filter((t) => parseInt(String(t.cashierId), 10) === rid);
        const ids = transactions.map((t) => Number(t.id)).filter((n) => Number.isFinite(n));
        const hasItems = await db.getTransactionIdsWithAnyItems(ids);
        transactions = transactions.filter((t) => hasItems.has(Number(t.id)));
        const byCashier: Record<string, { billCount: number; totalSales: number; firstAt: Date; lastAt: Date }> = {};
        for (const t of transactions) {
          const k = String(t.cashierId);
          if (!byCashier[k]) byCashier[k] = { billCount: 0, totalSales: 0, firstAt: t.createdAt, lastAt: t.createdAt };
          byCashier[k].billCount += 1;
          byCashier[k].totalSales += parseFloat(t.total || "0");
          if (new Date(t.createdAt) < new Date(byCashier[k].firstAt)) byCashier[k].firstAt = t.createdAt;
          if (new Date(t.createdAt) > new Date(byCashier[k].lastAt)) byCashier[k].lastAt = t.createdAt;
        }
        const cashierIds = Object.keys(byCashier);
        const names: Record<string, string> = {};
        for (const id of cashierIds) {
          const u = await db.getUserById(parseInt(id, 10), orgId);
          names[id] = u?.name ?? `#${id}`;
        }
        return Object.entries(byCashier)
          .map(([cashierId, v]) => ({
            cashierId: parseInt(cashierId, 10),
            cashierName: names[cashierId] ?? `#${cashierId}`,
            billCount: v.billCount,
            totalSales: v.totalSales,
            firstSaleAt: v.firstAt,
            lastSaleAt: v.lastAt,
          }))
          .sort((a, b) => b.totalSales - a.totalSales);
      }),

    /** รายละเอียดบิล — ดึงจาก order.items เท่านั้น ห้าม join products/stock/cart */
    getTransactionDetail: reportsProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        const t = await db.getTransactionById(input.id, orgId);
        if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "ไม่พบบิล" });
        const rid = (ctx as { reportRestrictCashierId?: number }).reportRestrictCashierId;
        if (rid != null && parseInt(String(t.cashierId), 10) !== rid) {
          throw new TRPCError({ code: "FORBIDDEN", message: "ไม่มีสิทธิ์ดูบิลนี้" });
        }
        const items = await db.getTransactionItems(t.id);
        const cashierName = (t as any).cashierName ?? (await db.getUserById(parseInt(String(t.cashierId), 10), orgId))?.name ?? `#${t.cashierId}`;
        return {
          transaction: t,
          cashierName,
          items: items.map((i) => ({
            productId: Number(i.productId),
            productName: (i as any).productName ?? `#${i.productId}`,
            quantity: i.quantity,
            unitPrice: i.unitPrice ?? "0",
            subtotal: i.subtotal ?? "0",
            toppings: i.toppings || [],
          })),
        };
      }),
  }),

  // ============ DISCOUNTS ============
  discounts: router({
    list: managerProcedure.query(async ({ ctx }) => { // Manager และ Admin ดูได้
      const orgId = db.getUserOrganizationId(ctx.user);
      return db.getDiscounts(orgId);
    }),
    
    active: posProcedure.query(async ({ ctx }) => {
      const orgId = db.getUserOrganizationId(ctx.user);
      return db.getActiveDiscounts(orgId);
    }),
    
    create: managerProcedure // Manager และ Admin สร้างได้
      .input(
        z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          type: z.enum(["percentage", "fixed_amount", "product_specific", "bill_total"]),
          value: z.string(),
          productId: z.string().optional(),
          minBillAmount: z.string().optional(),
          maxDiscountAmount: z.string().optional(),
          startDate: z.date().optional(),
          endDate: z.date().optional(),
          autoApply: z.boolean().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        if (!orgId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "ไม่พบข้อมูล organization",
          });
        }
        return db.createDiscount({ ...input, organizationId: orgId });
      }),
    
    update: adminProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          description: z.string().optional(),
          type: z.enum(["percentage", "fixed_amount", "product_specific", "bill_total"]).optional(),
          value: z.string().optional(),
          productId: z.string().optional(),
          minBillAmount: z.string().optional(),
          maxDiscountAmount: z.string().optional(),
          startDate: z.date().optional(),
          endDate: z.date().optional(),
          autoApply: z.boolean().optional(),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(({ input }) => {
        const { id, ...data } = input;
        return db.updateDiscount(id, data);
      }),
    
    delete: managerProcedure // Manager และ Admin ลบได้
      .input(z.object({ id: z.number() }))
      .mutation(({ input }) => db.deleteDiscount(input.id)),
  }),

  // ============ LOYALTY PROGRAM ============
  loyalty: router({
    addPoints: protectedProcedure
      .input(
        z.object({
          customerId: z.number(),
          points: z.number(),
          description: z.string().optional(),
          transactionId: z.number().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.addLoyaltyPoints(input.customerId, input.points, input.description, input.transactionId, orgId);
      }),
    
    redeemPoints: protectedProcedure
      .input(
        z.object({
          customerId: z.number(),
          points: z.number(),
          description: z.string().optional(),
        })
      )
      .mutation(({ input }) => db.redeemLoyaltyPoints(input.customerId, input.points, input.description)),
    
    getHistory: adminProcedure
      .input(z.object({ customerId: z.number() }))
      .query(({ input }) => db.getLoyaltyTransactionHistory(input.customerId)),
    
    getSettings: adminProcedure.query(() => db.getLoyaltySettings()),
    
    updateSettings: adminProcedure
      .input(
        z.object({
          pointsPerBaht: z.string().optional(),
          pointValue: z.string().optional(),
          pointExpirationDays: z.number().optional(),
          minPointsToRedeem: z.number().optional(),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(({ input }) => db.updateLoyaltySettings(input)),
  }),

  users: router({
    list: adminProcedure.query(async ({ ctx }) => {
      const orgId = db.getUserOrganizationId(ctx.user);
      return db.getUsers(orgId);
    }),
    
    get: adminProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.getUserById(input.id, orgId);
      }),
    
    create: adminProcedure
      .input(
        z.object({
          name: z.string().min(1),
          email: z.string().email(),
          phone: z.string().optional(),
          role: z.enum(["admin", "manager", "cashier"]),
          password: z.string().min(6),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        if (!orgId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "ไม่พบข้อมูลร้าน",
          });
        }
        if (!ctx.user.storeId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "กรุณาเชื่อมต่อร้านก่อน จึงจะเพิ่มผู้ใช้งานได้",
          });
        }
        // Subscription Plan guard: Basic = 1 account only (owner)
        await db.assertCanCreateStaffUserForOrg(orgId);
        return db.createUser(input, orgId, ctx.user.id, ctx.user.storeId);
      }),
    
    update: adminProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          email: z.string().email().optional(),
          phone: z.string().optional(),
          role: z.enum(["admin", "manager", "cashier"]).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.updateUser(input.id, input, orgId);
      }),
    
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        await db.deleteUser(input.id, orgId);
        return { success: true };
      }),
  }),

  // ============ EMAIL NOTIFICATIONS ============
  email: router({
    testConnection: adminProcedure.mutation(() => testEmailConnection()),

    sendDailySalesReport: adminProcedure
      .input(
        z.object({
          email: z.string().email(),
          date: z.string(),
          totalSales: z.number(),
          totalTransactions: z.number(),
          averageTransaction: z.number(),
          topProducts: z.array(
            z.object({
              name: z.string(),
              quantity: z.number(),
              revenue: z.number(),
            })
          ),
        })
      )
      .mutation(({ input }) =>
        sendDailySalesReport(input.email, {
          date: input.date,
          totalSales: input.totalSales,
          totalTransactions: input.totalTransactions,
          averageTransaction: input.averageTransaction,
          topProducts: input.topProducts,
        })
      ),

    sendLowStockAlert: adminProcedure
      .input(
        z.object({
          email: z.string().email(),
          products: z.array(
            z.object({
              name: z.string(),
              currentStock: z.number(),
              minimumThreshold: z.number(),
            })
          ),
        })
      )
      .mutation(({ input }) =>
        sendLowStockAlert(input.email, { products: input.products })
      ),
  }),

  receiptTemplates: router({
    list: publicProcedure.query(() => db.getReceiptTemplates()),
    
    get: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(({ input }) => db.getReceiptTemplate(input.id)),
    
    getDefault: posProcedure.query(() => db.getDefaultReceiptTemplate()),
    
    create: adminProcedure
      .input(
        z.object({
          name: z.string().min(1),
          headerText: z.string().optional(),
          footerText: z.string().optional(),
          showCompanyName: z.boolean().optional(),
          showDate: z.boolean().optional(),
          showTime: z.boolean().optional(),
          showCashier: z.boolean().optional(),
          showTransactionId: z.boolean().optional(),
          isDefault: z.boolean().optional(),
        })
      )
      .mutation(({ input }) => db.createReceiptTemplate(input)),
    
    update: adminProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          headerText: z.string().optional(),
          footerText: z.string().optional(),
          showCompanyName: z.boolean().optional(),
          showDate: z.boolean().optional(),
          showTime: z.boolean().optional(),
          showCashier: z.boolean().optional(),
          showTransactionId: z.boolean().optional(),
          isDefault: z.boolean().optional(),
        })
      )
      .mutation(({ input }) => {
        const { id, ...data } = input;
        return db.updateReceiptTemplate(id, data);
      }),
    
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(({ input }) => db.deleteReceiptTemplate(input.id)),
  }),

  // ============ DISCOUNT CODES ============
  discountCodes: router({
    create: adminProcedure
      .input(
        z.object({
          code: z.string().min(1).max(50),
          discountId: z.number(),
          maxUsageCount: z.number().min(1),
          description: z.string().optional(),
          endDate: z.date().optional(),
        })
      )
      .mutation(({ input }) => db.createDiscountCode(input)),
    
    validate: posProcedure
      .input(z.object({ code: z.string() }))
      .query(async ({ input }) => {
        const code = await db.validateDiscountCode(input.code);
        if (!code) return null;
        const discount = await db.getDiscountById(code.discountId);
        if (!discount || !discount.isActive) return null;
        const now = new Date();
        if (discount.startDate && new Date(discount.startDate) > now) return null;
        if (discount.endDate && new Date(discount.endDate) < now) return null;
        return { code, discount };
      }),
    
    incrementUsage: protectedProcedure
      .input(z.object({ codeId: z.number() }))
      .mutation(({ input }) => db.incrementDiscountCodeUsage(input.codeId)),
    
    get: publicProcedure
      .input(z.object({ id: z.number() }))
      .query(({ input }) => db.getDiscountCodeById(input.id)),
    
    list: adminProcedure
      .input(
        z.object({
          isActive: z.boolean().optional(),
          discountId: z.number().optional(),
        })
      )
      .query(({ input }) => db.listDiscountCodes(input)),
    
    update: adminProcedure
      .input(
        z.object({
          id: z.number(),
          isActive: z.boolean().optional(),
          maxUsageCount: z.number().optional(),
          endDate: z.date().optional(),
        })
      )
      .mutation(({ input }) => {
        const { id, ...data } = input;
        return db.updateDiscountCode(id, data);
      }),
    
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(({ input }) => db.deleteDiscountCode(input.id)),
  }),

  // ============ DASHBOARD ============
  dashboard: router({
    discountCodeStats: protectedProcedure
      .query(() => db.getDiscountCodeStatistics()),
    
    topDiscountCodes: protectedProcedure
      .input(z.object({ limit: z.number().optional() }))
      .query(({ input }) => db.getTopDiscountCodes(input.limit)),
    
    summary: protectedProcedure
      .query(async ({ ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.getDashboardSummary(orgId);
      }),
    
    recentActivities: protectedProcedure
      .input(z.object({ limit: z.number().optional() }))
      .query(({ input }) => db.getRecentActivities(input.limit)),
  }),

  // ============ TAX SYSTEM (ระบบภาษี) ============
  tax: router({
    // Company Profile
    getCompanyProfile: protectedProcedure.query(async ({ ctx }) => {
      const orgId = db.getUserOrganizationId(ctx.user);
      return db.getCompanyProfile(orgId);
    }),
    
    updateCompanyProfile: adminProcedure
      .input(
        z.object({
          name: z.string().min(1),
          taxId: z.string().length(13),
          address: z.string().min(1),
          district: z.string().optional(),
          province: z.string().optional(),
          postalCode: z.string().optional(),
          phone: z.string().optional(),
          email: z.string().email().optional(),
          businessType: z.string().optional(),
          vatRegistered: z.boolean(),
          vatNumber: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        if (!orgId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "ไม่พบข้อมูล organization",
          });
        }
        return db.upsertCompanyProfile(input, orgId);
      }),

    // Tax Invoices
    getTaxInvoice: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.getTaxInvoiceById(input.id, orgId);
      }),

    getTaxInvoiceByTransaction: protectedProcedure
      .input(z.object({ transactionId: z.number() }))
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.getTaxInvoiceByTransactionId(input.transactionId, orgId);
      }),

    getTaxInvoicesByDateRange: protectedProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
        })
      )
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.getTaxInvoicesByDateRange(input.startDate, input.endDate, orgId);
      }),

    cancelTaxInvoice: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.cancelTaxInvoice(input.id, orgId);
      }),

    // VAT Reports
    getVatReport: protectedProcedure
      .input(z.object({ month: z.string() }))
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.getVatReport(input.month, orgId);
      }),

    getVatReportsByYear: protectedProcedure
      .input(z.object({ year: z.number() }))
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.getVatReportsByYear(input.year, orgId);
      }),

    generateVatReport: adminProcedure
      .input(
        z.object({
          month: z.string(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // คำนวณ VAT จาก transactions และ tax invoices ในเดือนนั้น
        const [year, monthNum] = input.month.split("-").map(Number);
        const startDate = new Date(year, monthNum - 1, 1);
        const endDate = new Date(year, monthNum, 0, 23, 59, 59);
        
        const orgId = db.getUserOrganizationId(ctx.user);

        // VAT ขาย (จาก Tax Invoices)
        const invoices = await db.getTaxInvoicesByDateRange(startDate, endDate, orgId);
        const totalSales = invoices.reduce((sum, inv) => sum + inv.total, 0);
        const vatSales = invoices.reduce((sum, inv) => sum + inv.vat, 0);

        // VAT ซื้อ (จาก Purchase Invoices)
        const purchaseInvoices = await db.getPurchaseInvoicesByDateRange(startDate, endDate, orgId);
        const vatBuy = purchaseInvoices.reduce((sum, inv) => sum + inv.vat, 0);

        return db.createOrUpdateVatReport({
          month: input.month,
          totalSales,
          vatSales,
          vatBuy,
        }, orgId!);
      }),

    submitVatReport: adminProcedure
      .input(z.object({ month: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.submitVatReport(input.month, orgId);
      }),

    // Withholding Tax
    createWithholdingTax: adminProcedure
      .input(
        z.object({
          documentNo: z.string(),
          documentType: z.enum(["pnd3", "pnd53"]),
          payeeName: z.string().min(1),
          payeeTaxId: z.string(),
          payeeAddress: z.string().optional(),
          paymentDate: z.date(),
          paymentType: z.enum(["service", "rent", "freelance", "other"]),
          paymentAmount: z.number().positive(),
          withholdingRate: z.number().min(0).max(100),
        })
      )
      .mutation(({ input }) => db.createWithholdingTax(input)),

    getWithholdingTax: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(({ input }) => db.getWithholdingTaxById(input.id)),

    getWithholdingTaxesByDateRange: protectedProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
        })
      )
      .query(({ input }) =>
        db.getWithholdingTaxesByDateRange(input.startDate, input.endDate)
      ),

    getWithholdingTaxesByType: protectedProcedure
      .input(
        z.object({
          documentType: z.enum(["pnd3", "pnd53"]),
          year: z.number(),
        })
      )
      .query(({ input }) =>
        db.getWithholdingTaxesByType(input.documentType, input.year)
      ),

    // Annual Income Summary
    getAnnualIncomeSummary: protectedProcedure
      .input(z.object({ year: z.number() }))
      .query(({ input }) => db.getAnnualIncomeSummary(input.year)),

    generateAnnualIncomeSummary: adminProcedure
      .input(z.object({ year: z.number() }))
      .mutation(async ({ input, ctx }) => {
        // คำนวณรายได้และค่าใช้จ่ายจาก transactions ทั้งปี
        const startDate = new Date(input.year, 0, 1);
        const endDate = new Date(input.year, 11, 31, 23, 59, 59);

        const orgId = db.getUserOrganizationId(ctx.user);
        const transactions = await db.getTransactionsByDateRange(startDate, endDate, orgId);
        const totalRevenue = transactions.reduce(
          (sum, t) => sum + parseFloat(t.total || "0"),
          0
        );

        // TODO: คำนวณต้นทุนและค่าใช้จ่ายจาก inventory และ expenses
        const totalCost = 0;
        const totalExpenses = 0;

        return db.createOrUpdateAnnualIncomeSummary({
          year: input.year,
          totalRevenue,
          totalCost,
          totalExpenses,
        });
      }),

    finalizeAnnualIncomeSummary: adminProcedure
      .input(z.object({ year: z.number() }))
      .mutation(({ input }) => db.finalizeAnnualIncomeSummary(input.year)),
  }),

  // ============ PURCHASE INVOICES (ใบรับซื้อ) ============
  purchaseInvoices: router({
    create: adminProcedure
      .input(
        z.object({
          invoiceNo: z.string(),
          supplierName: z.string().min(1),
          supplierTaxId: z.string().optional(),
          supplierAddress: z.string().optional(),
          date: z.date(),
          subtotal: z.number(),
          vat: z.number(),
          total: z.number(),
          items: z.array(
            z.object({
              description: z.string(),
              quantity: z.number(),
              unitPrice: z.number(),
              amount: z.number(),
            })
          ),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        if (!orgId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "ไม่พบข้อมูล organization",
          });
        }
        return db.createPurchaseInvoice(input, orgId);
      }),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.getPurchaseInvoiceById(input.id, orgId);
      }),

    getByDateRange: protectedProcedure
      .input(
        z.object({
          startDate: z.date(),
          endDate: z.date(),
        })
      )
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.getPurchaseInvoicesByDateRange(input.startDate, input.endDate, orgId);
      }),

    cancel: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        return db.cancelPurchaseInvoice(input.id, orgId);
      }),
  }),

  // ============ TOPPINGS ============
  toppings: router({
    list: posProcedure.query(async ({ ctx }) => {
      const orgId = db.getUserOrganizationId(ctx.user);
      return db.getToppings(orgId);
    }),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(({ input }) => db.getToppingById(input.id)),

    create: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1),
          price: z.number().min(0),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        if (!orgId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "ไม่พบข้อมูล organization",
          });
        }
        return db.createTopping({
          name: input.name,
          price: input.price,
          organizationId: orgId,
        });
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().min(1).optional(),
          price: z.number().min(0).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return db.updateTopping(id, data);
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await db.deleteTopping(input.id);
        return { success: true };
      }),
  }),

  // ============ STORES (ห้องร้าน) ============
  stores: router({
    // หัวหน้าสร้างร้านใหม่
    create: adminProcedure
      .input(
        z.object({
          storeCode: z.string().min(1),
          name: z.string().min(1),
        })
      )
      .mutation(async ({ input, ctx }) => {
        return db.createStore({
          storeCode: input.storeCode,
          name: input.name,
          ownerId: ctx.user.id,
        });
      }),

    // ดึงร้านทั้งหมดของหัวหน้า
    list: adminProcedure.query(async ({ ctx }) => {
      return db.getStoresByOwner(ctx.user.id);
    }),

    // ดึงร้านตาม ID
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(({ input }) => db.getStoreById(input.id)),

    // สร้างรหัสเข้าร้าน
    createInvite: adminProcedure
      .input(
        z.object({
          storeId: z.number(),
          code: z.string().min(1),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        if (!orgId) throw new TRPCError({ code: "BAD_REQUEST", message: "ไม่พบข้อมูลร้าน" });
        await db.assertCanManageStoreInvites(orgId);
        return db.createStoreInvite({
          code: input.code,
          storeId: input.storeId,
          createdBy: ctx.user.id,
        });
      }),

    // ดึงรหัสเข้าร้านทั้งหมดของร้าน
    getInvites: adminProcedure
      .input(z.object({ storeId: z.number() }))
      .query(async ({ input, ctx }) => {
        const orgId = db.getUserOrganizationId(ctx.user);
        if (!orgId) throw new TRPCError({ code: "BAD_REQUEST", message: "ไม่พบข้อมูลร้าน" });
        await db.assertCanManageStoreInvites(orgId);
        return db.getStoreInvitesByStore(input.storeId);
      }),

    // อัปเดตสถานะรหัสเข้าร้าน
    updateInvite: adminProcedure
      .input(
        z.object({
          id: z.number(),
          active: z.boolean(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // NOTE: updateInvite ไม่มี storeId ใน input; แต่ถ้าเป็น Basic เราจะกันตั้งแต่ getInvites/createInvite แล้ว
        // ยังอัปเดตได้เฉพาะ Premium เท่านั้นใน flow ปกติ
        return db.updateStoreInvite(input.id, input.active);
      }),

    // พนักงานเข้าร้าน (กรอกรหัส)
    join: protectedProcedure
      .input(z.object({ code: z.string().min(1) }))
      .mutation(async ({ input, ctx }) => {
        // หารหัสเข้าร้าน
        const invite = await db.getStoreInviteByCode(input.code);
        if (!invite) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "รหัสเข้าร้านไม่ถูกต้องหรือหมดอายุ",
          });
        }

        // Subscription Plan guard: Basic = no staff join by invite
        // ownerId (organization) ของร้าน = store.ownerId (ต้องหา store ก่อน)
        const storeForJoin = await db.getStoreById(invite.storeId);
        if (!storeForJoin) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "ไม่พบร้านที่ระบุ",
          });
        }
        await db.assertCanJoinStoreByInvite(invite.storeId, storeForJoin.ownerId);

        // ตรวจสอบว่าร้านมีอยู่จริง
        const store = storeForJoin;

        // อัปเดต storeId และ organizationId (owner ของร้าน) ของ user
        await db.joinStore(ctx.user.id, invite.storeId, store.ownerId);

        return {
          success: true,
          storeId: store.id,
          storeName: store.name,
          message: `เข้าร้าน "${store.name}" สำเร็จ`,
        };
      }),

    // พนักงานออกจากร้าน
    leave: protectedProcedure.mutation(async ({ ctx }) => {
      await db.leaveStore(ctx.user.id);
      return { success: true, message: "ออกจากร้านสำเร็จ" };
    }),

    // ดึงผู้ใช้ทั้งหมดในร้าน (สำหรับหัวหน้า)
    getUsers: adminProcedure
      .input(z.object({ storeId: z.number() }))
      .query(({ input }) => db.getUsersByStore(input.storeId)),
  }),
});

export type AppRouter = typeof appRouter;
