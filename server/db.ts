import { getMongoDb } from "./_core/mongo";
import { ENV } from "./_core/env";
import { hashPassword, verifyPassword } from "./_core/passwords";
import { nanoid } from "nanoid";
import { TRPCError } from "@trpc/server";

type Role = "superadmin" | "admin" | "manager" | "cashier" | "user";

// ============ ADMIN CODES (รหัสแอดมิน) ============
// 1 รหัส = 1 ร้าน ใช้ได้ครั้งเดียว เมื่อลูกค้าซื้อระบบจาก Ordera จะได้รหัสไปกรอกเพื่อสร้างร้านและเป็น Admin
export type AdminCodeDoc = {
  id: number;
  code: string;
  used: boolean;
  usedAt: Date | null;
  usedBy: number | null;
  storeId: number | null;
  createdAt: Date;
};

export async function createAdminCode(): Promise<AdminCodeDoc> {
  const col = await getCollection<AdminCodeDoc>("adminCodes");
  const id = await getNextSeq("adminCodes");
  const code = "ORDERA-" + nanoid(10).toUpperCase().replace(/-/g, "");
  const now = new Date();
  const existing = await col.findOne({ code });
  if (existing) return createAdminCode(); // retry if collision
  const doc: AdminCodeDoc = {
    id,
    code,
    used: false,
    usedAt: null,
    usedBy: null,
    storeId: null,
    createdAt: now,
  };
  await col.insertOne(doc);
  return doc;
}

export async function getAdminCodeByCode(code: string): Promise<AdminCodeDoc | null> {
  const col = await getCollection<AdminCodeDoc>("adminCodes");
  return col.findOne({ code: code.trim().toUpperCase() });
}

export async function redeemAdminCode(code: string, userId: number): Promise<{ store: StoreDoc }> {
  const col = await getCollection<AdminCodeDoc>("adminCodes");
  const users = await getCollection<UserDoc>("users");
  const ac = await getAdminCodeByCode(code);
  if (!ac) throw new Error("รหัสแอดมินไม่ถูกต้อง");
  if (ac.used) throw new Error("รหัสแอดมินถูกใช้งานแล้ว");

  const user = await users.findOne({ id: userId });
  if (!user) throw new Error("ไม่พบผู้ใช้");

  const store = await createStore({
    storeCode: "STORE-" + Date.now(),
    name: `ร้านของ ${user.name || "ฉัน"}`,
    ownerId: userId,
  });

  const now = new Date();
  await col.updateOne(
    { id: ac.id },
    { $set: { used: true, usedAt: now, usedBy: userId, storeId: store.id } }
  );
  await users.updateOne(
    { id: userId },
    { $set: { storeId: store.id, role: "admin", organizationId: null, updatedAt: now } }
  );

  return { store };
}

export type UserDoc = {
  id: number;
  openId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  loginMethod: string | null;
  passwordHash: string | null;
  passwordSalt: string | null;
  role: Role;
  organizationId: number | null; // null = organization ของตัวเอง (owner)
  storeId: number | null; // เพิ่ม storeId สำหรับระบบห้องร้าน (null = ยังไม่อยู่ร้านไหน)
  createdBy: number | null; // null = สร้างเอง, number = user id ที่สร้าง
  createdAt: Date;
  updatedAt: Date;
  lastSignedIn: Date;
};

async function getCollection<T extends Record<string, unknown>>(name: string) {
  const db = await getMongoDb();
  return db.collection<T>(name);
}

async function getNextSeq(name: string) {
  const counters = await getCollection<{ _id: string; seq: number }>("counters");
  const result = await counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  const doc = result && typeof result === "object" && "value" in result ? (result as { value?: { seq?: number } }).value : result;
  return (doc as { seq?: number } | null)?.seq ?? 1;
}

// Get next sequence for a specific organization (for multi-tenant isolation)
async function getNextSeqForOrg(name: string, organizationId: number) {
  const counters = await getCollection<{ _id: string; seq: number }>("counters");
  const counterKey = `${name}_org_${organizationId}`;
  const result = await counters.findOneAndUpdate(
    { _id: counterKey },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  const doc = result && typeof result === "object" && "value" in result ? (result as { value?: { seq?: number } }).value : result;
  return (doc as { seq?: number } | null)?.seq ?? 1;
}

// Export getNextSeq for use in routers
export { getNextSeq, getNextSeqForOrg };

/** คำนวณ check digit EAN-13 จากตัวเลข 12 หลัก */
function ean13CheckDigit(digits12: string): number {
  if (digits12.length !== 12) return 0;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const w = (11 - i) % 2 === 0 ? 3 : 1;
    sum += parseInt(digits12[i], 10) * w;
  }
  return (10 - (sum % 10)) % 10;
}

/** สร้างบาร์โค้ด EAN-13: 885 + productId (pad ซ้าย 9 หลัก) + check digit — ใช้ productId จาก DB เท่านั้น */
export function generateEAN13(productId: number): string {
  const base = "885" + String(Math.max(0, productId)).padStart(9, "0").slice(-9);
  const check = ean13CheckDigit(base);
  return base + String(check);
}

let barcodeUniqueIndexEnsured = false;

/** บังคับ barcode unique ระดับร้าน/org — ตั้ง unique index (ห้ามข้าม) */
export async function ensureBarcodeUniqueIndex(): Promise<void> {
  if (barcodeUniqueIndexEnsured) return;
  barcodeUniqueIndexEnsured = true;
  try {
    const products = await getCollection<any>("products");
    // ใช้เฉพาะ $exists + $gt (MongoDB บางเวอร์ชันไม่รองรับ $type ใน partial index)
    await products.createIndex(
      { organizationId: 1, barcode: 1 },
      {
        unique: true,
        partialFilterExpression: {
          barcode: { $exists: true, $gt: "" },
        },
      }
    );
  } catch (err) {
    console.warn("[ensureBarcodeUniqueIndex] Index creation failed, enforcing in application:", err);
    // ไม่ throw — ยังบังคับซ้ำในโค้ด (getProductByBarcode ก่อน save/update)
  }
}

// ============ USERS ============
// Helper: Get organizationId for a user
// ถ้า organizationId = null หมายความว่า user เป็น owner ใช้ user.id เป็น organizationId
export function getUserOrganizationId(user: { id: number; organizationId?: number | null } | null): number | null {
  if (!user) return null;
  return user.organizationId ?? user.id;
}

export async function upsertUser(user: {
  openId: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  loginMethod?: string | null;
  role?: Role;
  lastSignedIn?: Date;
  passwordHash?: string | null;
  passwordSalt?: string | null;
}) {
  const users = await getCollection<UserDoc>("users");
  const existing = await users.findOne({ openId: user.openId });
  const now = new Date();
  if (!existing) {
    const role =
      user.role ??
      (user.openId === ENV.ownerOpenId ? "admin" : "cashier");
    await users.insertOne({
      id: await getNextSeq("users"),
      openId: user.openId,
      name: user.name ?? null,
      email: user.email ?? null,
      phone: user.phone ?? null,
      loginMethod: user.loginMethod ?? null,
      passwordHash: user.passwordHash ?? null,
      passwordSalt: user.passwordSalt ?? null,
      role,
      organizationId: null,
      createdBy: null,
      storeId: null,
      createdAt: now,
      updatedAt: now,
      lastSignedIn: user.lastSignedIn ?? now,
    } as UserDoc);
    return;
  }

  const update: Partial<UserDoc> = {
    updatedAt: now,
  };
  if (user.name !== undefined) update.name = user.name ?? null;
  if (user.email !== undefined) update.email = user.email ?? null;
  if (user.phone !== undefined) update.phone = user.phone ?? null;
  if (user.loginMethod !== undefined) update.loginMethod = user.loginMethod ?? null;
  if (user.passwordHash !== undefined) update.passwordHash = user.passwordHash ?? null;
  if (user.passwordSalt !== undefined) update.passwordSalt = user.passwordSalt ?? null;
  if (user.role !== undefined) update.role = user.role;
  if (user.openId === ENV.ownerOpenId) update.role = "admin";
  if (user.lastSignedIn !== undefined) update.lastSignedIn = user.lastSignedIn;
  await users.updateOne({ openId: user.openId }, { $set: update });
}

export async function getUserByOpenId(openId: string) {
  const users = await getCollection<UserDoc>("users");
  return users.findOne({ openId });
    }

export async function getUserByEmail(email: string) {
  const users = await getCollection<UserDoc>("users");
  const emailLower = email.toLowerCase();
  console.log("[getUserByEmail] Searching for email:", emailLower);
  const candidates = await users
    .find({ email: emailLower })
    .sort({ updatedAt: -1, id: -1 })
    .toArray();
  const result =
    candidates.find((u) => !!u.passwordHash && !!u.passwordSalt) ?? candidates[0] ?? null;
  if (result) {
    console.log("[getUserByEmail] Found user:", {
      id: result.id,
      email: result.email,
      name: result.name,
      role: result.role,
      candidates: candidates.length,
      hasPassword: !!result.passwordHash,
    });
  } else {
    console.log("[getUserByEmail] No user found with email:", emailLower);
  }
  return result;
}

export async function getUserByInviteCode(inviteCode: string) {
  const users = await getCollection<UserDoc>("users");
  // inviteCode จะเป็น format: INVITE-{userId}-{timestamp}
  const parts = inviteCode.split("-");
  if (parts.length >= 2 && parts[0] === "INVITE") {
    const userId = parseInt(parts[1]);
    if (!isNaN(userId)) {
      const user = await users.findOne({ id: userId });
      // ตรวจสอบว่า user เป็น manager/admin และมี organizationId
      if (user && (user.role === "manager" || user.role === "admin")) {
        return user;
      }
    }
  }
  return null;
}

export async function getUserCount(): Promise<number> {
  const users = await getCollection<UserDoc>("users");
  return users.countDocuments({});
}

export async function getAdminCount(): Promise<number> {
  const users = await getCollection<UserDoc>("users");
  return users.countDocuments({ role: "admin" });
}

// Helper to get collection (exported for use in routers)
export async function getCollectionAsync<T extends Record<string, unknown>>(name: string) {
  const db = await getMongoDb();
  return db.collection<T>(name);
}

export async function createInternalUser(data: {
  name: string;
  email: string;
  password: string;
  role?: Role;
  organizationId?: number | null;
  createdBy?: number | null;
  storeId?: number | null;
}) {
  try {
    console.log("[createInternalUser] Starting user creation...");
    const users = await getCollection<UserDoc>("users");
    console.log("[createInternalUser] Collection obtained");
    
    const emailLower = data.email.toLowerCase();
    
    // ✅ ตรวจสอบ email ก่อนทุกอย่าง (สำคัญมาก!)
    console.log("[createInternalUser] Checking if email exists:", emailLower);
    const existing = await users.findOne({ email: emailLower });
    if (existing) {
      console.log("[createInternalUser] ❌ Email already exists:", { 
        existingId: existing.id, 
        existingEmail: existing.email,
        existingName: existing.name,
        newEmail: emailLower 
      });
      throw new Error(`Email ${emailLower} is already registered`);
    }
    console.log("[createInternalUser] ✅ Email is available");
    
    const now = new Date();
    const { hash, salt } = hashPassword(data.password);
    console.log("[createInternalUser] Password hashed");
    
    const role = data.role ?? "manager";
    let userId = await getNextSeq("users");
    console.log("[createInternalUser] Generated user ID:", userId);
    
    // Double check that this ID doesn't already exist (safety check)
    const existingById = await users.findOne({ id: userId });
    if (existingById) {
      console.warn(`[createInternalUser] ⚠️ User ID ${userId} already exists! Getting max ID...`);
      // Get the max ID and use that + 1
      const maxUser = await users.find({}).sort({ id: -1 }).limit(1).toArray();
      const maxId = maxUser.length > 0 ? maxUser[0].id : 0;
      userId = maxId + 1;
      console.log(`[createInternalUser] Using manual ID: ${userId} (max was ${maxId})`);
      // Update counter to match
      const counters = await getCollection<{ _id: string; seq: number }>("counters");
      await counters.updateOne(
        { _id: "users" },
        { $set: { seq: userId } },
        { upsert: true }
      );
    }
    
    const doc: UserDoc = {
      id: userId,
      openId: `local_${Date.now()}_${userId}`,
      name: data.name || null,
      email: emailLower,
      phone: null,
      loginMethod: "internal",
      passwordHash: hash,
      passwordSalt: salt,
      role,
      organizationId: data.organizationId ?? null,
      createdBy: data.createdBy ?? null,
      storeId: data.storeId ?? null,
      createdAt: now,
      updatedAt: now,
      lastSignedIn: now,
    };
    console.log("[createInternalUser] Document prepared:", { id: doc.id, email: doc.email, name: doc.name });
    console.log("[createInternalUser] Attempting to insert into MongoDB...");
    
    const result = await users.insertOne(doc);
    console.log("[createInternalUser] Insert result:", {
      insertedId: result.insertedId,
      acknowledged: result.acknowledged
    });
    
    if (!result.insertedId) {
      console.error("[createInternalUser] ❌ Insert failed - no insertedId returned");
      throw new Error("Failed to insert user into database - no insertedId");
    }
    
    if (!result.acknowledged) {
      console.error("[createInternalUser] ❌ Insert not acknowledged by MongoDB");
      throw new Error("Failed to insert user into database - not acknowledged");
    }
    
    // Verify the user was actually inserted
    const verifyUser = await users.findOne({ id: userId });
    if (!verifyUser) {
      console.error("[createInternalUser] ❌ User not found after insert");
      throw new Error("Failed to verify user insertion");
    }
    
    console.log("[createInternalUser] ✅ User successfully created and verified:", {
      id: verifyUser.id,
      email: verifyUser.email,
      name: verifyUser.name
    });
    
    return doc;
  } catch (error) {
    console.error("[createInternalUser] ❌ Error creating user:", error);
    console.error("[createInternalUser] Error stack:", error instanceof Error ? error.stack : "No stack");
    if (error instanceof Error) {
      throw new Error(`Failed to create user: ${error.message}`);
    }
    throw error;
  }
}

export function verifyUserPassword(
  user: { passwordHash?: string | null; passwordSalt?: string | null },
  password: string
) {
  if (!user.passwordHash || !user.passwordSalt) return false;
  return verifyPassword(password, user.passwordSalt, user.passwordHash);
    }

export async function updateUserPasswordByEmail(email: string, password: string) {
  const users = await getCollection<UserDoc>("users");
  const { hash, salt } = hashPassword(password);
  const result = await users.updateMany(
    { email: email.toLowerCase() },
    { $set: { passwordHash: hash, passwordSalt: salt, updatedAt: new Date() } }
  );
  return (result.matchedCount ?? 0) > 0;
    }

export async function updateUserRoleByEmail(email: string, role: Role) {
  const users = await getCollection<UserDoc>("users");
  const result = await users.updateMany(
    { email: email.toLowerCase() },
    { $set: { role, updatedAt: new Date() } }
  );
  return (result.matchedCount ?? 0) > 0;
}

export async function getUsers(organizationId?: number | null) {
  const users = await getCollection<UserDoc>("users");
  const query: any = {};
  // Filter by organizationId: ถ้า organizationId = null หมายความว่า user เป็น owner ใช้ user.id เป็น organizationId
  // ถ้า organizationId != null หมายความว่า user เป็นสมาชิกของ organization นั้น
  if (organizationId !== undefined && organizationId !== null) {
    query.$or = [
      { organizationId: organizationId }, // สมาชิกของ organization
      { id: organizationId, organizationId: null }, // owner ของ organization
    ];
  }
  const results = await users.find(query).sort({ createdAt: 1 }).toArray();
  return results.map(user => ({
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    createdAt: user.createdAt,
  }));
}

export async function getUserById(id: number, organizationId?: number | null) {
  const users = await getCollection<UserDoc>("users");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.$or = [
      { organizationId: organizationId },
      { id: organizationId, organizationId: null },
    ];
  }
  return users.findOne(query);
}

export async function createUser(
  data: {
    name: string;
    email: string;
    phone?: string;
    role: "admin" | "manager" | "cashier";
    password: string;
  },
  organizationId: number,
  createdBy: number,
  storeId: number
) {
  return createInternalUser({
    name: data.name,
    email: data.email,
    password: data.password,
    role: data.role,
    organizationId,
    createdBy,
    storeId,
  });
}

export async function updateUser(
  id: number,
  data: Partial<{ name: string; email: string; phone: string; role: Role }>,
  organizationId?: number | null
) {
  const users = await getCollection<UserDoc>("users");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.$or = [
      { organizationId: organizationId },
      { id: organizationId, organizationId: null },
    ];
  }
  const update: Partial<UserDoc> = { updatedAt: new Date() };
  if (data.name !== undefined) update.name = data.name ?? null;
  if (data.email !== undefined) update.email = data.email ?? null;
  if (data.phone !== undefined) update.phone = data.phone ?? null;
  if (data.role !== undefined) update.role = data.role;
  await users.updateOne(query, { $set: update });
}

export async function deleteUser(id: number, organizationId?: number | null) {
  const users = await getCollection<UserDoc>("users");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.$or = [
      { organizationId: organizationId },
      { id: organizationId, organizationId: null },
    ];
  }
  await users.deleteOne(query);
}

// ============ CATEGORIES ============
export async function getCategories(organizationId?: number | null) {
  const categories = await getCollection<any>("categories");
  const query: any = { isActive: true };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return categories.find(query).sort({ displayOrder: 1 }).toArray();
}

export async function getCategoryById(id: number, organizationId?: number | null) {
  const categories = await getCollection<any>("categories");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return categories.findOne(query);
}

/**
 * สร้างหมวดหมู่ใหม่
 * ทุกครั้งที่สร้าง → ระบบสร้าง ID อัตโนมัติทันที (getNextSeq) ห้ามใช้ ID เดิม/กรอก ID เอง
 * ถ้าตรวจพบ ID ซ้ำใน org เดียวกันจะไม่บันทึกและแจ้งเตือน
 */
export async function createCategory(data: {
  name: string;
  description?: string;
  displayOrder?: number;
  organizationId: number;
}) {
  const categories = await getCollection<any>("categories");
  const counters = await getCollection<{ _id: string; seq: number }>("counters");
  const now = new Date();
  // สร้าง ID อัตโนมัติทันทีทุกครั้งที่สร้างหมวดหมู่
  let id = await getNextSeq("categories");
  let existing = await categories.findOne({
    organizationId: data.organizationId,
    id,
  });
  // ถ้า ID ซ้ำ (counter ต่ำกว่า id สูงสุดใน DB) ใช้ max(id)+1 แล้วอัปเดต counter
  if (existing) {
    const maxDoc = await categories.find({}).sort({ id: -1 }).limit(1).toArray();
    const maxId = (maxDoc[0] as { id: number } | undefined)?.id ?? 0;
    id = maxId + 1;
    await counters.updateOne(
      { _id: "categories" },
      { $max: { seq: id } },
      { upsert: true }
    );
  }
  const doc = {
    id,
    name: data.name,
    description: data.description ?? null,
    displayOrder: data.displayOrder ?? 0,
    isActive: true,
    organizationId: data.organizationId,
    createdAt: now,
    updatedAt: now,
  };
  await categories.insertOne(doc);
  return doc;
}

/**
 * อัปเดตหมวดหมู่ — ห้ามแก้ไข ID หมวดหมู่ (ระบบเป็นผู้กำหนด ID ให้เองเสมอ)
 */
export async function updateCategory(
  id: number,
  data: Partial<{
    name: string;
    description: string;
    displayOrder: number;
    isActive: boolean;
  }>,
  organizationId?: number | null
) {
  const categories = await getCollection<any>("categories");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  const { id: _noId, ...safeData } = data as Record<string, unknown>;
  await categories.updateOne(query, {
    $set: { ...safeData, updatedAt: new Date() },
  });
}

export async function deleteCategory(id: number, organizationId?: number | null) {
  const categories = await getCollection<any>("categories");
  const products = await getCollection<any>("products");
  const productQuery: any = { categoryId: id };
  if (organizationId !== undefined && organizationId !== null) {
    productQuery.organizationId = organizationId;
  }
  const count = await products.countDocuments(productQuery);
  if (count > 0) {
    throw new Error("ไม่สามารถลบได้ เนื่องจากมีสินค้าในหมวดหมู่นี้");
  }
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  await categories.deleteOne(query);
}

/**
 * แก้หมวดหมู่ที่ id ซ้ำใน org เดียวกัน (ทำให้เลือก/บันทึกหมวดถูกต้อง)
 * ใช้: pnpm exec tsx scripts/fix-duplicate-category-ids.ts
 * หรือกดปุ่ม "แก้ไข id หมวดหมู่ที่ซ้ำ" ใน Dialog จัดการหมวดหมู่
 */
export async function fixDuplicateCategoryIds(): Promise<{ updated: number }> {
  const categories = await getCollection<any>("categories");
  const all = await categories.find({}).sort({ organizationId: 1, id: 1, _id: 1 }).toArray();
  const byKey = new Map<string, any[]>();
  for (const c of all) {
    const org = c.organizationId ?? "_";
    const key = `${org}:${c.id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(c);
  }
  let maxId = 0;
  for (const c of all) if (typeof c.id === "number" && c.id > maxId) maxId = c.id;
  let updated = 0;
  for (const [, docs] of byKey) {
    if (docs.length <= 1) continue;
    docs.sort((a, b) => (a._id < b._id ? -1 : 1));
    for (let i = 1; i < docs.length; i++) {
      maxId += 1;
      const newId = maxId;
      await categories.updateOne(
        { _id: docs[i]._id },
        { $set: { id: newId, updatedAt: new Date() } }
      );
      updated++;
      console.log(`[fixDuplicateCategoryIds] ${docs[i].name} (org ${docs[i].organizationId}) id ${docs[i].id} -> ${newId}`);
    }
  }
  if (maxId > 0) {
    const counters = await getCollection<{ _id: string; seq: number }>("counters");
    await counters.updateOne(
      { _id: "categories" },
      { $set: { seq: maxId } },
      { upsert: true }
    );
  }
  return { updated };
}

// ============ PRODUCTS ============
export async function getProducts(filters?: {
  categoryId?: number;
  status?: "active" | "inactive";
  search?: string;
  organizationId?: number | null;
}) {
  const products = await getCollection<any>("products");
  const query: Record<string, unknown> = {};
  if (filters && filters.categoryId != null) query.categoryId = filters.categoryId;
  // Default to "active" if status is not specified
  query.status = filters?.status || "active";
  if (filters?.search) query.name = { $regex: filters.search, $options: "i" };
  if (filters?.organizationId !== undefined && filters?.organizationId !== null) {
    query.organizationId = filters.organizationId;
  }
  return products.find(query).sort({ createdAt: -1 }).toArray();
}

export async function getProductById(id: number, organizationId?: number | null) {
  const products = await getCollection<any>("products");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return products.findOne(query);
}

export async function getProductBySku(sku: string, organizationId?: number | null) {
  const products = await getCollection<any>("products");
  const query: any = { sku };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return products.findOne(query);
}

/** Lookup product by barcode (optional field) */
export async function getProductByBarcode(barcode: string, organizationId?: number | null) {
  const products = await getCollection<any>("products");
  const query: any = { barcode };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return products.findOne(query);
}

/**
 * Lookup for POS scan: รองรับ (1) รหัสสินค้า/บาร์โค้ด (2) QR จากเครื่องชั่ง productCode|weight|totalPrice
 * Returns: { type: 'product', product } | { type: 'scale', product, totalPrice } | null
 */
export async function lookupProductByScan(
  code: string,
  organizationId?: number | null
): Promise<
  | { type: "product"; product: any }
  | { type: "scale"; product: any; totalPrice: number }
  | null
> {
  const trimmed = (code || "").trim();
  if (!trimmed) return null;

  const products = await getCollection<any>("products");
  const orgQuery = organizationId != null ? { organizationId } : {};

  // 2️⃣ รูปแบบ QR เครื่องชั่ง: productCode|weight|totalPrice (ห้ามคำนวณราคาใหม่ ใช้ราคาที่มากับ QR)
  const scaleParts = trimmed.split("|").map((s) => s.trim());
  if (scaleParts.length === 3) {
    const [productCode, _weight, totalPriceStr] = scaleParts;
    const totalPrice = parseFloat(totalPriceStr);
    if (!productCode || Number.isNaN(totalPrice)) return null;
    let product = await products.findOne({
      ...orgQuery,
      status: "active",
      $or: [{ sku: productCode }, { barcode: productCode }],
    });
    if (!product) return null;
    return { type: "scale", product, totalPrice };
  }

  // 1️⃣ บาร์โค้ดแบบเซเว่น (EAN-13 ฯลฯ) — ค้นหาจาก barcode ก่อน
  const byBarcode = await products.findOne({ ...orgQuery, barcode: trimmed, status: "active" });
  if (byBarcode) return { type: "product", product: byBarcode };

  // 2️⃣ รหัสสินค้า (id ตัวเลข) / SKU
  const byId = /^\d+$/.test(trimmed)
    ? await products.findOne({ ...orgQuery, id: parseInt(trimmed, 10), status: "active" })
    : null;
  if (byId) return { type: "product", product: byId };

  const bySku = await products.findOne({ ...orgQuery, sku: trimmed, status: "active" });
  if (bySku) return { type: "product", product: bySku };

  return null;
}

/**
 * Flow การสร้างสินค้า (ต้องเป็นแบบนี้เท่านั้น)
 * STEP 1: บันทึกสินค้า (barcode = null ถ้าไม่กรอกเอง)
 * STEP 2: Database สร้าง productId จริง (getNextSeq)
 * STEP 3: ใช้ productId นี้สร้าง barcode (generateEAN13) — หลัง STEP 2 เท่านั้น
 * STEP 4: UPDATE product.barcode
 *
 * เช็กให้ชัวร์:
 * - barcode ถูกสร้างหลัง save ใช่ไหม → ใช่ (STEP 3 หลัง insert)
 * - productId มาจาก DB จริงใช่ไหม → ใช่ (getNextSeq)
 * - barcode unique ใน DB ใช่ไหม → ใช่ (unique index + ตรวจก่อน update)
 */
export async function createProduct(data: {
  sku: string;
  name: string;
  description?: string;
  categoryId: number;
  price: string;
  cost?: string;
  imageUrl?: string | null;
  barcode?: string | null;
  organizationId: number;
}) {
  try {
    await ensureBarcodeUniqueIndex();
    const products = await getCollection<any>("products");
    const now = new Date();
    const productId = await getNextSeq("products");
    const userProvidedBarcode =
      data.barcode != null && String(data.barcode).trim()
        ? String(data.barcode).trim()
        : null;

    // STEP 1+2: บันทึกสินค้าก่อน (barcode = null ถ้าไม่กรอกเอง)
    const doc = {
      id: productId,
      sku: data.sku,
      name: data.name,
      description: data.description ?? null,
      categoryId: data.categoryId,
      price: data.price,
      cost: data.cost ?? null,
      imageUrl: data.imageUrl ?? null,
      barcode: userProvidedBarcode,
      barcodeType: userProvidedBarcode ? "EAN13" : null,
      status: "active",
      organizationId: data.organizationId,
      createdAt: now,
      updatedAt: now,
    };
    await products.insertOne(doc);

    // สร้าง inventory entry อัตโนมัติ (แยกต่อร้านด้วย organizationId)
    const inventory = await getCollection<any>("inventory");
    const orgId = data.organizationId;
    const existingInventory = await inventory.findOne({ productId, organizationId: orgId });
    if (!existingInventory) {
      await inventory.insertOne({
        productId,
        organizationId: orgId,
        quantity: 0,
        minThreshold: 10,
        createdAt: now,
        updatedAt: now,
      });
    }

    // STEP 3+4: ถ้าไม่กรอกบาร์โค้ดเอง → generate หลัง save แล้ว update
    if (!userProvidedBarcode) {
      const generatedBarcode = generateEAN13(productId);
      const existing = await getProductByBarcode(
        generatedBarcode,
        data.organizationId
      );
      if (existing && existing.id !== productId) {
        // ซ้ำ (ไม่ควรเกิด): generate ใหม่ด้วย suffix หรือ throw
        throw new Error(
          `บาร์โค้ดที่สร้างซ้ำ (productId=${productId}) กรุณาลองใหม่`
        );
      }
      await products.updateOne(
        { id: productId, organizationId: data.organizationId },
        { $set: { barcode: generatedBarcode, barcodeType: "EAN13", updatedAt: new Date() } }
      );
      (doc as any).barcode = generatedBarcode;
      (doc as any).barcodeType = "EAN13";
    }

    return doc;
  } catch (error) {
    console.error("[db.createProduct] Error:", error);
    throw error;
  }
}

/**
 * แก้สินค้าเก่าที่บาร์โค้ดซ้ำ: ล้าง barcode ที่ซ้ำ → generate ใหม่ทีละสินค้า (จาก productId)
 * ห้ามใช้บาร์โค้ดเดิมต่อ
 */
export async function fixDuplicateBarcodes(): Promise<{ cleared: number; regenerated: number }> {
  const products = await getCollection<any>("products");
  const pipeline = [
    { $match: { barcode: { $exists: true, $nin: [null, ""] } } },
    { $group: { _id: { barcode: "$barcode", organizationId: "$organizationId" }, count: { $sum: 1 }, ids: { $push: "$id" } } },
    { $match: { count: { $gt: 1 } } },
  ];
  const duplicates = await products.aggregate(pipeline).toArray();
  let cleared = 0;
  const productIdsToRegen: { id: number; organizationId: number }[] = [];
  for (const d of duplicates) {
    const { barcode, organizationId } = d._id;
    const ids = d.ids as number[];
    await products.updateMany(
      { barcode, organizationId },
      { $set: { barcode: null, barcodeType: null, updatedAt: new Date() } }
    );
    cleared += ids.length;
    for (const id of ids) {
      productIdsToRegen.push({ id, organizationId });
    }
  }
  productIdsToRegen.sort((a, b) => a.id - b.id);
  let regenerated = 0;
  for (const { id, organizationId } of productIdsToRegen) {
    const newBarcode = generateEAN13(id);
    const existing = await getProductByBarcode(newBarcode, organizationId);
    if (existing && existing.id !== id) continue; // ข้ามถ้าซ้ำ (ไม่ควรเกิด)
    await products.updateOne(
      { id, organizationId },
      { $set: { barcode: newBarcode, barcodeType: "EAN13", updatedAt: new Date() } }
    );
    regenerated++;
  }
  return { cleared, regenerated };
}

/**
 * สร้างบาร์โค้ดใหม่จาก productId เดิม (ปุ่มแก้ฉุกเฉิน, admin only)
 * Overwrite ค่าเดิม, barcode ต้อง unique ต่อ org
 */
export async function regenerateProductBarcode(
  productId: number,
  organizationId: number
): Promise<string> {
  const products = await getCollection<any>("products");
  const product = await products.findOne({
    id: productId,
    organizationId,
  });
  if (!product) {
    throw new Error("ไม่พบสินค้า");
  }
  const newBarcode = generateEAN13(productId);
  const existing = await getProductByBarcode(newBarcode, organizationId);
  if (existing && existing.id !== productId) {
    throw new Error("บาร์โค้ดที่สร้างซ้ำ กรุณาลองใหม่");
  }
  await products.updateOne(
    { id: productId, organizationId },
    { $set: { barcode: newBarcode, barcodeType: "EAN13", updatedAt: new Date() } }
  );
  return newBarcode;
}

/**
 * หา product ที่ id ซ้ำในร้านเดียวกัน (ถ้ามี = สต็อกจะแสดงเท่ากันทั้งสองตัว)
 */
export async function findDuplicateProductIds(organizationId: number): Promise<{ id: number; count: number; skus: string[] }[]> {
  const products = await getCollection<any>("products");
  const docs = await products.find({ organizationId }).toArray();
  const byId = new Map<number, any[]>();
  for (const d of docs) {
    const id = d.id;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(d);
  }
  const result: { id: number; count: number; skus: string[] }[] = [];
  for (const [id, list] of Array.from(byId.entries())) {
    if (list.length > 1) {
      result.push({
        id,
        count: list.length,
        skus: list.map((p: any) => p.sku ?? ""),
      });
    }
  }
  return result;
}

/**
 * แก้ product id ซ้ำ: ให้สินค้าที่ซ้ำได้ id ใหม่และแถว inventory แยก (กันสต็อกลดทั้งสองตัว)
 */
export async function fixDuplicateProductIds(
  organizationId: number | null
): Promise<{ updated: number }> {
  const products = await getCollection<any>("products");
  const inventory = await getCollection<any>("inventory");
  const orgFilter: any =
    organizationId != null
      ? { organizationId }
      : { $or: [{ organizationId: null }, { organizationId: { $exists: false } }] };
  const docs = await products.find(orgFilter).toArray();
  const byId = new Map<number, any[]>();
  for (const d of docs) {
    const id = d.id;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(d);
  }
  let updated = 0;
  for (const [, list] of Array.from(byId.entries())) {
    if (list.length <= 1) continue;
    list.sort((a: any, b: any) => (a.createdAt ? new Date(a.createdAt).getTime() : 0) - (b.createdAt ? new Date(b.createdAt).getTime() : 0));
    for (let i = 1; i < list.length; i++) {
      const doc = list[i];
      const newId = await getNextSeq("products");
      await products.updateOne(
        { _id: doc._id },
        { $set: { id: newId, updatedAt: new Date() } }
      );
      const existingInv = await inventory.findOne(
        organizationId != null
          ? { productId: doc.id, organizationId }
          : { productId: doc.id, $or: [{ organizationId: null }, { organizationId: { $exists: false } }] }
      );
      await inventory.insertOne({
        productId: newId,
        organizationId: organizationId ?? null,
        quantity: 0,
        minThreshold: existingInv?.minThreshold ?? 10,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      updated++;
    }
  }
  return { updated };
}

/** แก้ product id ซ้ำทั้งหมด (ทุก organization) */
export async function fixAllDuplicateProductIds(): Promise<{ totalUpdated: number; byOrg: Record<string, number> }> {
  const products = await getCollection<any>("products");
  const orgIds = await products.distinct("organizationId");
  let totalUpdated = 0;
  const byOrg: Record<string, number> = {};
  for (const oid of orgIds) {
    const { updated } = await fixDuplicateProductIds(oid);
    if (updated > 0) {
      byOrg[oid == null ? "null" : String(oid)] = updated;
      totalUpdated += updated;
    }
  }
  if (!orgIds.some((x) => x == null)) {
    const { updated } = await fixDuplicateProductIds(null);
    if (updated > 0) {
      byOrg["null"] = updated;
      totalUpdated += updated;
    }
  }
  return { totalUpdated, byOrg };
}

export async function updateProduct(
  id: number,
  data: Partial<{
    sku: string;
    name: string;
    description: string;
    categoryId: number;
    price: string;
    cost: string;
    imageUrl: string | null | undefined;
    barcode: string | null | undefined;
    barcodeType: string | null | undefined;
    status: "active" | "inactive";
  }>,
  organizationId?: number | null
) {
  const products = await getCollection<any>("products");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  await products.updateOne(query, { $set: { ...data, updatedAt: new Date() } });
}

export async function deleteProduct(id: number, organizationId?: number | null) {
  const products = await getCollection<any>("products");
  const inventory = await getCollection<any>("inventory");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  console.log("[db.deleteProduct] Query:", JSON.stringify(query));
  
  // Check if product exists
  const product = await products.findOne(query);
  if (!product) {
    console.warn("[db.deleteProduct] No product found with query:", query);
    throw new Error("ไม่พบสินค้าที่ต้องการลบ");
  }
  
  // Delete inventory records for this product
  const inventoryDeleteResult = await inventory.deleteMany({ productId: id });
  console.log("[db.deleteProduct] Deleted inventory records:", inventoryDeleteResult.deletedCount);
  
  // Delete the product from database
  const result = await products.deleteOne(query);
  console.log("[db.deleteProduct] Delete result:", result);
  
  if (result.deletedCount === 0) {
    console.warn("[db.deleteProduct] Product found but not deleted. Query:", query);
    throw new Error("ไม่สามารถลบสินค้าได้");
  }
  
  console.log("[db.deleteProduct] Product deleted successfully from database");
  return result;
}

// ============ INVENTORY ============
// 1 สินค้า = 1 รหัส (productId) = 1 แถวสต็อกต่อร้าน (organizationId) → เพิ่ม/ลดเฉพาะตัวนั้น
export async function getInventoryList(search?: string, organizationId?: number | null) {
  const inventory = await getCollection<any>("inventory");
  const products = await getCollection<any>("products");
  const productQuery: any = { status: "active" };
  if (organizationId != null) {
    productQuery.$or = [
      { organizationId },
      { organizationId: null },
      { organizationId: { $exists: false } },
    ];
  }
  const productDocs = await products.find(productQuery).toArray();
  const invByProduct = new Map<number, { quantity: number; minThreshold: number }>();
  const invQuery: any =
    organizationId != null
      ? { $or: [{ organizationId }, { organizationId: null }, { organizationId: { $exists: false } }] }
      : { $or: [{ organizationId: null }, { organizationId: { $exists: false } }] };
  const invList = await inventory.find(invQuery).toArray();
  for (const item of invList) {
    const itemOrg = item.organizationId;
    if (organizationId != null) {
      const itemOrgVal = itemOrg ?? null;
      if (itemOrgVal !== null && itemOrgVal !== organizationId) continue;
      if (itemOrgVal === organizationId) {
        invByProduct.set(Number(item.productId), {
          quantity: Number(item.quantity) || 0,
          minThreshold: Number(item.minThreshold) || 10,
        });
        continue;
      }
      if (itemOrgVal === null && invByProduct.has(Number(item.productId))) continue;
    } else {
      if (itemOrg != null && itemOrg !== undefined) continue;
    }
    let pid = Number(item.productId);
    if (Number.isNaN(pid)) pid = Number(String(item.productId).trim());
    if (Number.isNaN(pid)) continue;
    invByProduct.set(pid, {
      quantity: Number(item.quantity) || 0,
      minThreshold: Number(item.minThreshold) || 10,
    });
  }
  const joined = productDocs.map((p) => {
    const inv = invByProduct.get(p.id);
    return {
      productId: String(p.id),
      quantity: inv?.quantity ?? 0,
      minThreshold: inv?.minThreshold ?? 10,
      sku: p.sku,
      productName: p.name,
      price: p.price,
    };
  });
  const filtered = search
    ? joined.filter(
        (i) =>
          (i.productName || "").toLowerCase().includes(search.toLowerCase()) ||
          (i.sku || "").toLowerCase().includes(search.toLowerCase())
      )
    : joined;
  return filtered.sort((a, b) => (a.productName || "").localeCompare(b.productName || ""));
}

export async function getInventoryByProductId(productId: number, organizationId?: number | null) {
  const inventory = await getCollection<any>("inventory");
  const products = await getCollection<any>("products");
  const pid = Number(productId);
  if (organizationId != null) {
    const product = await products.findOne({
      id: pid,
      $or: [{ organizationId }, { organizationId: null }, { organizationId: { $exists: false } }],
    });
    if (!product) return null;
  }

  const filters: any[] =
    organizationId != null
      ? [
          { productId: pid, organizationId },
          { productId: String(productId), organizationId },
          { productId: pid },
          { productId: String(productId) },
        ]
      : [
          { productId: pid },
          { productId: String(productId) },
        ];

  for (const filter of filters) {
    const row = await inventory.findOne(filter);
    if (row) return row;
  }
  return null;
}

/** อัปเดตสต็อกเฉพาะ productId นี้ของร้านนี้เท่านั้น */
export async function updateInventory(productId: number, quantity: number, organizationId?: number | null) {
  const inventory = await getCollection<any>("inventory");
  const products = await getCollection<any>("products");
  const pid = Number(productId);
  const qty = Number(quantity);
  const orgId = organizationId ?? null;

  const productExists = await products.findOne({
    id: pid,
    $or: orgId != null
      ? [{ organizationId: orgId }, { organizationId: null }, { organizationId: { $exists: false } }]
      : [{ organizationId: null }, { organizationId: { $exists: false } }],
  });
  if (!productExists) {
    const anyProduct = await products.findOne({ id: pid });
    if (anyProduct) {
      throw new Error(`สินค้านี้อยู่ในร้านอื่น ไม่สามารถเพิ่มสต็อกได้`);
    }
    throw new Error("ไม่พบสินค้านี้ในระบบ");
  }

  const effectiveOrgId = productExists.organizationId ?? orgId;
  const allRows = await inventory
    .find({
      $or: [{ productId: pid }, { productId: String(productId) }, { productId: String(pid) }],
    })
    .toArray();

  let existing: any = null;
  if (allRows.length === 1) {
    existing = allRows[0];
  } else if (allRows.length > 1) {
    const preferred = allRows.find((r) => (r.organizationId ?? null) === (orgId ?? null));
    const fallback = allRows.find((r) => (r.organizationId ?? null) === (effectiveOrgId ?? null));
    existing = preferred ?? fallback ?? allRows[0];
  }

  if (existing) {
    const result = await inventory.updateOne(
      { _id: existing._id },
      {
        $set: {
          productId: pid,
          quantity: qty,
          organizationId: effectiveOrgId ?? existing.organizationId ?? null,
          updatedAt: new Date(),
        },
      }
    );
    if (result.matchedCount === 0) {
      throw new Error("Failed to update inventory");
    }
    return;
  }

  await inventory.insertOne({
    productId: pid,
    quantity: qty,
    minThreshold: 10,
    organizationId: effectiveOrgId ?? orgId,
    updatedAt: new Date(),
  });
}

export async function getLowStockProducts(threshold?: number) {
  const inventory = await getCollection<any>("inventory");
  return inventory
    .find({ quantity: { $lte: threshold ?? 10 } })
    .toArray();
}

export async function getStockMovementHistory(productId: number) {
  const movements = await getCollection<any>("stockMovements");
  return movements.find({ productId }).sort({ createdAt: -1 }).toArray();
}

export async function recordStockMovement(data: {
  productId: number;
  movementType: "in" | "out" | "adjustment";
  quantity: number;
  reason?: string;
  userId?: number;
  notes?: string;
}) {
  const movements = await getCollection<any>("stockMovements");
  await movements.insertOne({
    productId: data.productId,
    movementType: data.movementType,
    quantity: data.quantity,
    reason: data.reason,
    userId: data.userId?.toString(),
    notes: data.notes,
    createdAt: new Date(),
  });
}

// ============ CUSTOMERS ============
export async function getCustomers(search?: string, organizationId?: number | null) {
  const customers = await getCollection<any>("customers");
  const query: any = {};
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  if (!search) {
    return customers.find(query).sort({ createdAt: -1 }).toArray();
  }
  const regex = new RegExp(search, "i");
  query.$or = [{ name: regex }, { phone: regex }, { email: regex }];
  return customers.find(query).sort({ createdAt: -1 }).toArray();
}

export async function getCustomerById(id: number, organizationId?: number | null) {
  const customers = await getCollection<any>("customers");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return customers.findOne(query);
}

export async function createCustomer(data: {
  id?: number; // ID ที่กำหนดเอง (optional)
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  organizationId: number;
}) {
  try {
    console.log("[createCustomer] Starting customer creation...");
    const customers = await getCollection<any>("customers");
    console.log("[createCustomer] Collection obtained");
    
    const now = new Date();
    
    // ถ้ามี ID ที่กำหนดมาให้ใช้ ID นั้น ถ้าไม่มีให้ใช้ auto-increment
    let customerId: number;
    if (data.id !== undefined) {
      customerId = data.id;
      console.log("[createCustomer] Using provided ID:", customerId);
      
      // ตรวจสอบว่า ID ไม่ซ้ำใน organization เดียวกัน
      const existing = await customers.findOne({ 
        id: customerId,
        organizationId: data.organizationId 
      });
      if (existing) {
        console.error("[createCustomer] ❌ ID already exists in this organization:", customerId);
        throw new Error(`ID ${customerId} ถูกใช้งานแล้วในรหัสนี้`);
      }
      
      // อัปเดต counter ของ organization นี้ให้สูงกว่า ID ที่กำหนด (เพื่อไม่ให้ ID ซ้ำในอนาคต)
      const counters = await getCollection<{ _id: string; seq: number }>("counters");
      const counterKey = `customers_org_${data.organizationId}`;
      const currentCounter = await counters.findOne({ _id: counterKey });
      const currentSeq = currentCounter?.seq ?? 0;
      if (customerId > currentSeq) {
        await counters.updateOne(
          { _id: counterKey },
          { $set: { seq: customerId } },
          { upsert: true }
        );
        console.log("[createCustomer] Counter updated to:", customerId, "for organization:", data.organizationId);
      }
    } else {
      // ใช้ counter แยกตาม organization
      customerId = await getNextSeqForOrg("customers", data.organizationId);
      console.log("[createCustomer] Generated customer ID:", customerId, "for organization:", data.organizationId);
    }
    
  const doc = {
    id: customerId,
    name: data.name,
    phone: data.phone ?? null,
    email: data.email ?? null,
    address: data.address ?? null,
    notes: data.notes ?? null,
    loyaltyPoints: 0, // เริ่มต้นที่ 0
    totalSpent: "0",
    organizationId: data.organizationId,
    createdAt: now,
    updatedAt: now,
  };
    
    console.log("[createCustomer] Document prepared:", { id: doc.id, name: doc.name, email: doc.email, organizationId: doc.organizationId });
    console.log("[createCustomer] Attempting to insert into MongoDB...");
    
    const result = await customers.insertOne(doc);
    console.log("[createCustomer] Insert result:", {
      insertedId: result.insertedId,
      acknowledged: result.acknowledged
    });
    
    if (!result.insertedId) {
      console.error("[createCustomer] ❌ Insert failed - no insertedId returned");
      throw new Error("Failed to insert customer into database - no insertedId");
    }
    
    if (!result.acknowledged) {
      console.error("[createCustomer] ❌ Insert not acknowledged by MongoDB");
      throw new Error("Failed to insert customer into database - not acknowledged");
    }
    
    // Verify the customer was actually inserted
    const verifyCustomer = await customers.findOne({ 
      id: customerId,
      organizationId: data.organizationId 
    });
    if (!verifyCustomer) {
      console.error("[createCustomer] ❌ Customer not found after insert");
      throw new Error("Failed to verify customer insertion");
    }
    
    console.log("[createCustomer] ✅ Customer successfully created and verified:", {
      id: verifyCustomer.id,
      name: verifyCustomer.name,
      email: verifyCustomer.email,
      organizationId: verifyCustomer.organizationId
    });
    
    return doc;
  } catch (error) {
    console.error("[createCustomer] ❌ Error creating customer:", error);
    console.error("[createCustomer] Error stack:", error instanceof Error ? error.stack : "No stack");
    if (error instanceof Error) {
      throw new Error(`Failed to create customer: ${error.message}`);
    }
    throw error;
  }
}

export async function updateCustomer(
  id: number,
  data: Partial<{
    name: string;
    phone: string;
    email: string;
    address: string;
    notes: string;
    loyaltyPoints: number;
    totalSpent: string;
  }>,
  organizationId?: number | null
) {
  const customers = await getCollection<any>("customers");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  await customers.updateOne(query, { $set: { ...data, updatedAt: new Date() } });
}

export async function deleteCustomer(id: number, organizationId?: number | null) {
  const customers = await getCollection<any>("customers");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  await customers.deleteOne(query);
}

export async function getCustomerPurchaseHistory(customerId: number, organizationId?: number | null) {
  const transactions = await getCollection<any>("transactions");
  const query: any = { customerId };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return transactions.find(query).sort({ createdAt: -1 }).toArray();
}

// ============ TRANSACTIONS ============
export async function createTransaction(data: {
  transactionNumber: string;
  cashierId: number;
  cashierName: string; // ฝังชื่อพนักงานตอนบันทึก (ไม่ต้อง JOIN ทีหลัง)
  customerId?: number;
  subtotal: string;
  tax: string;
  discount: string;
  total: string;
  paymentMethod: "cash" | "transfer" | "card" | "ewallet" | "mixed";
  notes?: string;
  organizationId: number;
}) {
  const transactions = await getCollection<any>("transactions");
  const now = new Date();
  const id = await getNextSeq("transactions");
  const doc = {
    id,
    transactionNumber: data.transactionNumber,
    cashierId: data.cashierId.toString(),
    cashierName: data.cashierName, // เก็บชื่อพนักงานตอนบันทึก
    customerId: data.customerId ?? null,
    subtotal: data.subtotal,
    tax: data.tax,
    discount: data.discount,
    total: data.total,
    paymentMethod: data.paymentMethod,
    paymentStatus: "completed",
    notes: data.notes,
    organizationId: data.organizationId,
    createdAt: now,
    updatedAt: now,
  };
  await transactions.insertOne(doc);
  return doc;
}

export async function getTransactionById(id: number, organizationId?: number | null) {
  const transactions = await getCollection<any>("transactions");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return transactions.findOne(query);
}

export async function getTransactionsByDateRange(startDate: Date, endDate: Date, organizationId?: number | null) {
  const transactions = await getCollection<any>("transactions");
  const query: any = { createdAt: { $gte: startDate, $lte: endDate } };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return transactions
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
}

/**
 * Return a Set of transactionIds that have at least 1 item row.
 * Used to avoid counting "orphan" transactions (created then failed mid-flow).
 */
export async function getTransactionIdsWithAnyItems(transactionIds: number[]): Promise<Set<number>> {
  const set = new Set<number>();
  if (transactionIds.length === 0) return set;
  const items = await getCollection<any>("transactionItems");
  const rows = await items
    .aggregate([
      { $match: { transactionId: { $in: transactionIds } } },
      { $group: { _id: "$transactionId" } },
    ])
    .toArray();
  for (const r of rows) {
    const id = Number(r?._id);
    if (Number.isFinite(id)) set.add(id);
  }
  return set;
}

/** เก็บ productName ตอนสร้างบิล — รายละเอียดบิลใช้ order.items เท่านั้น ห้าม join products */
export async function createTransactionItem(data: {
  transactionId: number;
  productId: number;
  productName?: string; // ชื่อสินค้าตอนขาย (snapshot) ใช้แสดงรายละเอียดบิลโดยไม่ join products
  quantity: number;
  unitPrice: string;
  discount: string;
  subtotal: string;
  toppings?: Array<{ id: number; name: string; price: number }>;
}) {
  const items = await getCollection<any>("transactionItems");
  await items.insertOne({
    id: await getNextSeq("transactionItems"),
    transactionId: data.transactionId,
    productId: data.productId,
    productName: data.productName ?? null, // ราคา/ชื่อจากบิลเท่านั้น
    quantity: data.quantity,
    unitPrice: data.unitPrice,
    discount: data.discount,
    subtotal: data.subtotal,
    toppings: data.toppings || [],
    createdAt: new Date(),
  });
}

/** ดึงรายการในบิล — รวมรายการซ้ำ (productId+unitPrice+toppings เดียวกัน) เป็น 1 แถว เพื่อบิลเก่าที่มี 58 แถวแสดงเป็น 1 รายการ */
export async function getTransactionItems(transactionId: number) {
  const items = await getCollection<any>("transactionItems");
  const rows = await items.find({ transactionId }).toArray();
  const key = (r: any) =>
    `${r.productId}|${r.unitPrice ?? ""}|${JSON.stringify((r.toppings || []).slice().sort((a: any, b: any) => (a?.id ?? 0) - (b?.id ?? 0)))}`;
  const byKey = new Map<string, any>();
  for (const r of rows) {
    const k = key(r);
    const qty = Number(r.quantity) || 0;
    const sub = parseFloat(String(r.subtotal || "0")) || 0;
    const cur = byKey.get(k);
    if (cur) {
      cur.quantity += qty;
      cur.subtotal += sub;
    } else {
      byKey.set(k, {
        ...r,
        quantity: qty,
        subtotal: sub,
      });
    }
  }
  return Array.from(byKey.values()).map((r) => ({
    ...r,
    subtotal: typeof r.subtotal === "number" ? r.subtotal.toFixed(2) : String(r.subtotal ?? "0"),
  }));
}

/** นับจำนวนรายการในบิล (รวมรายการซ้ำ productId+unitPrice = 1 รายการ) — บิลเก่า 58 แถวซ้ำจะนับเป็น 1 */
export async function getTransactionLineCounts(transactionIds: number[]): Promise<Record<number, number>> {
  if (transactionIds.length === 0) return {};
  const items = await getCollection<any>("transactionItems");
  const result = await items.aggregate([
    { $match: { transactionId: { $in: transactionIds } } },
    {
      $group: {
        _id: {
          transactionId: "$transactionId",
          productId: "$productId",
          unitPrice: { $ifNull: ["$unitPrice", ""] },
        },
      },
    },
    { $group: { _id: "$_id.transactionId", lineCount: { $sum: 1 } } },
  ]).toArray();
  const counts: Record<number, number> = {};
  for (const txId of transactionIds) counts[txId] = 0;
  for (const r of result) counts[Number(r._id)] = Number(r.lineCount) || 0;
  return counts;
}

/** นับจำนวนชิ้นสินค้า (quantity รวม) สำหรับแต่ละ transaction - ใช้ MongoDB aggregation (วิธีที่แน่ใจที่สุด) */
export async function getTransactionItemCounts(transactionIds: number[]): Promise<Record<number, number>> {
  if (transactionIds.length === 0) return {};
  const items = await getCollection<any>("transactionItems");
  
  // ใช้ MongoDB aggregation เพื่อนับ quantity โดยตรงจากฐานข้อมูล
  // วิธีนี้แน่ใจที่สุดเพราะ MongoDB จะนับให้โดยตรง ไม่ผ่าน JavaScript
  const aggregationResult = await items.aggregate([
    { $match: { transactionId: { $in: transactionIds } } },
    {
      $addFields: {
        // แปลง quantity เป็น number (รองรับทั้ง string และ number)
        qtyNum: {
          $cond: [
            { $eq: [{ $type: "$quantity" }, "number"] },
            { $ifNull: ["$quantity", 0] },
            { $toDouble: { $ifNull: ["$quantity", "0"] } }
          ]
        }
      }
    },
    {
      $group: {
        _id: "$transactionId",
        totalQuantity: { $sum: "$qtyNum" },
        itemRows: { $sum: 1 } // นับจำนวนแถวด้วย (สำหรับ debug)
      }
    }
  ]).toArray();
  
  // Debug: log ผลลัพธ์ aggregation (sample)
  if (aggregationResult.length > 0) {
    const sample = aggregationResult.slice(0, 3);
    console.log(`[getTransactionItemCounts] Aggregation result (first 3):`, 
      sample.map(r => ({ txId: r._id, totalQty: r.totalQuantity, itemRows: r.itemRows })));
  }
  
  // แปลงผลลัพธ์เป็น map
  const counts: Record<number, number> = {};
  
  // Initialize: ทุก transaction เริ่มต้นที่ 0
  for (const txId of transactionIds) {
    counts[txId] = 0;
  }
  
  // ใส่ค่าจาก aggregation result
  for (const result of aggregationResult) {
    const txId = Number(result._id);
    const qty = Number(result.totalQuantity) || 0;
    counts[txId] = qty;
    
    // Debug: log สำหรับ transaction ที่มี quantity ผิดปกติ
    if (qty > 50) {
      console.warn(`[getTransactionItemCounts] Transaction ${txId} has unusual quantity: ${qty} (${result.itemRows} item rows)`);
      // Query items ของ transaction นี้เพื่อดูรายละเอียด
      const txItems = await items.find({ transactionId: txId }).limit(10).toArray();
      console.warn(`[getTransactionItemCounts] Transaction ${txId} items (first 10):`, 
        txItems.map(i => ({ 
          productId: i.productId, 
          quantity: i.quantity, 
          qtyType: typeof i.quantity,
          subtotal: i.subtotal
        })));
    }
  }
  
  return counts;
}

export async function getTransactionItemsByTransactionIds(transactionIds: number[]) {
  if (transactionIds.length === 0) return [];
  const items = await getCollection<any>("transactionItems");
  return items.find({ transactionId: { $in: transactionIds } }).toArray();
}

export async function getTopSellingProducts(
  startDate: Date,
  endDate: Date,
  limit: number = 10,
  organizationId?: number | null,
  cashierId?: number | null
) {
  const items = await getCollection<any>("transactionItems");
  const transactions = await getCollection<any>("transactions");
  const txQuery: any = { createdAt: { $gte: startDate, $lte: endDate } };
  if (organizationId !== undefined && organizationId !== null) {
    txQuery.organizationId = organizationId;
  }
  let txs = await transactions.find(txQuery).toArray();
  if (cashierId != null) {
    txs = txs.filter((t) => parseInt(String(t.cashierId), 10) === cashierId);
  }
  const txIds = new Set(txs.map(t => t.id));
  const allItems = await items.find({ transactionId: { $in: [...txIds] } }).toArray();
  const sales: Record<string, { productId: string; quantity: number; revenue: number }> = {};
  for (const item of allItems) {
    const key = item.productId.toString();
    if (!sales[key]) sales[key] = { productId: key, quantity: 0, revenue: 0 };
    sales[key].quantity += item.quantity;
    sales[key].revenue += parseFloat(item.subtotal || "0");
  }
  return Object.values(sales)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

// ============ ACTIVITY LOGS ============
export async function recordActivityLog(data: {
  userId: number;
  action: string;
  entityType?: string;
  entityId?: number;
  details?: Record<string, unknown>;
  ipAddress?: string;
}) {
  const logs = await getCollection<any>("activityLogs");
  await logs.insertOne({
    ...data,
    userId: data.userId.toString(),
    entityId: data.entityId?.toString(),
    createdAt: new Date(),
  });
}

export async function getActivityLogs(userId?: number, limit: number = 100) {
  const logs = await getCollection<any>("activityLogs");
  const query = userId ? { userId: userId.toString() } : {};
  return logs.find(query).sort({ createdAt: -1 }).limit(limit).toArray();
}

// ============ DISCOUNTS ============
export async function createDiscount(data: {
  name: string;
  description?: string;
  type: "percentage" | "fixed_amount" | "product_specific" | "bill_total";
  value: string;
  productId?: string;
  minBillAmount?: string;
  maxDiscountAmount?: string;
  startDate?: Date;
  endDate?: Date;
  autoApply?: boolean;
  organizationId: number;
}) {
  const discounts = await getCollection<any>("discounts");
  const now = new Date();
  const doc = {
    id: await getNextSeq("discounts"),
    name: data.name,
    description: data.description ?? null,
    type: data.type,
    value: data.value,
    productId: data.productId ?? null,
    minBillAmount: data.minBillAmount ?? null,
    maxDiscountAmount: data.maxDiscountAmount ?? null,
    startDate: data.startDate ?? null,
    endDate: data.endDate ?? null,
    autoApply: Boolean(data.autoApply),
    isActive: true,
    organizationId: data.organizationId,
    createdAt: now,
    updatedAt: now,
  };
  await discounts.insertOne(doc);
  return doc;
}

export async function getDiscounts(organizationId?: number | null) {
  const discounts = await getCollection<any>("discounts");
  const query: any = {};
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return discounts.find(query).sort({ createdAt: -1 }).toArray();
}

export async function getDiscountById(id: number) {
  const discounts = await getCollection<any>("discounts");
  return discounts.findOne({ id });
}

export async function getActiveDiscounts(organizationId?: number | null) {
  const discounts = await getCollection<any>("discounts");
  const now = new Date();
  const query: any = {
    isActive: true,
    $and: [
      { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
      { $or: [{ endDate: null }, { endDate: { $gte: now } }] },
    ],
  };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return discounts
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
}

export async function updateDiscount(
  id: number,
  data: Partial<{
    name: string;
    description: string;
    type: "percentage" | "fixed_amount" | "product_specific" | "bill_total";
    value: string;
    productId: string;
    minBillAmount: string;
    maxDiscountAmount: string;
    startDate: Date;
    endDate: Date;
    autoApply: boolean;
    isActive: boolean;
  }>
) {
  const discounts = await getCollection<any>("discounts");
  await discounts.updateOne({ id }, { $set: { ...data, updatedAt: new Date() } });
}

export async function deleteDiscount(id: number) {
  const discounts = await getCollection<any>("discounts");
  await discounts.deleteOne({ id });
}

// ============ LOYALTY ============
export async function addLoyaltyPoints(
  customerId: number,
  points: number,
  description?: string,
  transactionId?: number,
  organizationId?: number | null
) {
  try {
    console.log("[addLoyaltyPoints] Starting...", { customerId, points, description, transactionId, organizationId });
    const customers = await getCollection<any>("customers");
    const transactions = await getCollection<any>("loyaltyTransactions");
    
    // Find customer with organizationId filter
    const query: any = { id: customerId };
    if (organizationId !== undefined && organizationId !== null) {
      query.organizationId = organizationId;
    }
    
    const customer = await customers.findOne(query);
    if (!customer) {
      console.error("[addLoyaltyPoints] ❌ Customer not found:", { customerId, organizationId });
      throw new Error(`Customer not found (ID: ${customerId}, Organization: ${organizationId})`);
    }
    
    const balanceBefore = customer.loyaltyPoints || 0;
  const balanceAfter = balanceBefore + points;

    console.log("[addLoyaltyPoints] Updating customer points:", {
      customerId,
      organizationId,
      balanceBefore,
      points,
      balanceAfter
    });
    
    // Update customer with organizationId filter
    await customers.updateOne(
      query,
      { $set: { loyaltyPoints: balanceAfter, updatedAt: new Date() } }
    );
    
    const loyaltyTransactionId = await getNextSeq("loyaltyTransactions");
    await transactions.insertOne({
      id: loyaltyTransactionId,
    customerId,
      transactionId: transactionId ?? null,
      type: "add",
    points,
    balanceBefore,
    balanceAfter,
      reason: description || "Earned points",
      createdAt: new Date(),
    });
    
    console.log("[addLoyaltyPoints] ✅ Points added successfully:", {
      customerId,
      organizationId,
      points,
      newBalance: balanceAfter
    });
    
    return { success: true, newBalance: balanceAfter };
  } catch (error) {
    console.error("[addLoyaltyPoints] ❌ Error:", error);
    throw error;
  }
}

export async function redeemLoyaltyPoints(
  customerId: number,
  points: number,
  description?: string
) {
  const customers = await getCollection<any>("customers");
  const transactions = await getCollection<any>("loyaltyTransactions");
  const customer = await customers.findOne({ id: customerId });
  if (!customer) throw new Error("Customer not found");
  const balanceBefore = customer.loyaltyPoints || 0;
  if (balanceBefore < points) throw new Error("Insufficient loyalty points");
  const balanceAfter = balanceBefore - points;
  await customers.updateOne({ id: customerId }, { $set: { loyaltyPoints: balanceAfter } });
  await transactions.insertOne({
    id: await getNextSeq("loyaltyTransactions"),
    customerId,
    transactionId: null,
    type: "redeem",
    points,
    balanceBefore,
    balanceAfter,
    description,
    createdAt: new Date(),
  });
}

export async function getLoyaltyTransactionHistory(customerId: number) {
  const transactions = await getCollection<any>("loyaltyTransactions");
  return transactions.find({ customerId }).sort({ createdAt: -1 }).toArray();
}

export async function getLoyaltySettings() {
  const settings = await getCollection<any>("loyaltySettings");
  return settings.findOne({ _id: "default" });
}

export async function updateLoyaltySettings(data: Record<string, unknown>) {
  const settings = await getCollection<any>("loyaltySettings");
  await settings.updateOne(
    { _id: "default" },
    { $set: { ...data, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
  return settings.findOne({ _id: "default" });
}

// ============ RECEIPT TEMPLATES ============
export async function createReceiptTemplate(data: any) {
  const templates = await getCollection<any>("receiptTemplates");
  if (data.isDefault) {
    await templates.updateMany({}, { $set: { isDefault: false } });
  }
  const now = new Date();
  const doc = {
    id: await getNextSeq("receiptTemplates"),
    ...data,
    createdAt: now,
    updatedAt: now,
  };
  await templates.insertOne(doc);
  return doc;
}

export async function updateReceiptTemplate(id: number, data: any) {
  const templates = await getCollection<any>("receiptTemplates");
  if (data.isDefault) {
    await templates.updateMany({}, { $set: { isDefault: false } });
  }
  await templates.updateOne({ id }, { $set: { ...data, updatedAt: new Date() } });
  return templates.findOne({ id });
}

export async function deleteReceiptTemplate(id: number) {
  const templates = await getCollection<any>("receiptTemplates");
  await templates.deleteOne({ id });
}

export async function getReceiptTemplates() {
  const templates = await getCollection<any>("receiptTemplates");
  return templates.find({}).sort({ name: 1 }).toArray();
}

export async function getDefaultReceiptTemplate() {
  const templates = await getCollection<any>("receiptTemplates");
  // หา template ที่ isDefault = true ก่อน
  const defaultTemplate = await templates.findOne({ isDefault: true });
  if (defaultTemplate) {
    return defaultTemplate;
  }
  // ถ้าไม่มี default ให้ใช้ template แรกที่เจอ
  const firstTemplate = await templates.findOne({}, { sort: { createdAt: -1 } });
  return firstTemplate;
}

export async function getReceiptTemplate(id: number) {
  const templates = await getCollection<any>("receiptTemplates");
  return templates.findOne({ id });
}

// ============ DISCOUNT CODES ============
export async function createDiscountCode(data: {
  code: string;
  discountId: number;
  maxUsageCount: number;
  description?: string;
  endDate?: Date;
}) {
  const codes = await getCollection<any>("discountCodes");
  const now = new Date();
  const doc = {
    id: await getNextSeq("discountCodes"),
    code: data.code,
    discountId: data.discountId,
    maxUsageCount: data.maxUsageCount ?? null,
    usageCount: 0,
    description: data.description ?? null,
    endDate: data.endDate ?? null,
    isActive: true,
    startDate: now,
    createdAt: now,
    updatedAt: now,
  };
  await codes.insertOne(doc);
  return doc;
}

export async function validateDiscountCode(code: string) {
  const codes = await getCollection<any>("discountCodes");
  const now = new Date();
  const record = await codes.findOne({ code, isActive: true });
  if (!record) return null;
  if (record.startDate && record.startDate > now) return null;
  if (record.endDate && record.endDate < now) return null;
  if (record.maxUsageCount !== null && record.usageCount >= record.maxUsageCount) {
    return null;
  }
  return record;
}

export async function incrementDiscountCodeUsage(codeId: number) {
  const codes = await getCollection<any>("discountCodes");
  await codes.updateOne({ id: codeId }, { $inc: { usageCount: 1 } });
}

export async function getDiscountCodeById(id: number) {
  const codes = await getCollection<any>("discountCodes");
  return codes.findOne({ id });
}

export async function listDiscountCodes(filters?: {
  isActive?: boolean;
  discountId?: number;
}) {
  const codes = await getCollection<any>("discountCodes");
  const query: Record<string, unknown> = {};
  if (filters?.isActive !== undefined) query.isActive = filters.isActive;
  if (filters?.discountId !== undefined) query.discountId = filters.discountId;
  return codes.find(query).sort({ createdAt: -1 }).toArray();
}

export async function updateDiscountCode(id: number, data: {
  isActive?: boolean;
  maxUsageCount?: number;
  endDate?: Date;
}) {
  const codes = await getCollection<any>("discountCodes");
  await codes.updateOne({ id }, { $set: { ...data, updatedAt: new Date() } });
}

export async function deleteDiscountCode(id: number) {
  const codes = await getCollection<any>("discountCodes");
  await codes.deleteOne({ id });
}

// ============ DASHBOARD ============
export async function getDiscountCodeStatistics() {
  const codes = await getCollection<any>("discountCodes");
  const allCodes = await codes.find({}).toArray();
  const totalCodes = allCodes.length;
  const activeCodes = allCodes.filter(c => c.isActive).length;
  const usedCodes = allCodes.filter(c => (c.usageCount || 0) > 0).length;
  const totalUsage = allCodes.reduce((sum, c) => sum + (c.usageCount || 0), 0);
  const totalCapacity = allCodes.reduce((sum, c) => sum + (c.maxUsageCount || 0), 0);
  return {
    totalCodes,
    activeCodes,
    usedCodes,
    totalUsage,
    totalCapacity,
    utilizationRate: totalCapacity > 0 ? (totalUsage / totalCapacity) * 100 : 0,
  };
}

export async function getTopDiscountCodes(limit: number = 5) {
  const codes = await getCollection<any>("discountCodes");
  return codes.find({}).sort({ usageCount: -1 }).limit(limit).toArray();
}

export async function getRecentActivities(limit: number = 10) {
  const logs = await getCollection<any>("activityLogs");
  return logs.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function getDashboardSummary(organizationId?: number | null) {
  const transactions = await getCollection<any>("transactions");
  const customers = await getCollection<any>("customers");
  const products = await getCollection<any>("products");
  const activityLogs = await getCollection<any>("activityLogs");

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  // Build query with organizationId filter
  const transactionQuery: any = {};
  const customerQuery: any = {};
  const productQuery: any = {};
  
  if (organizationId !== undefined && organizationId !== null) {
    transactionQuery.organizationId = organizationId;
    customerQuery.organizationId = organizationId;
    productQuery.organizationId = organizationId;
  }

  // Get today's sales
  const todayTransactionQuery = {
    ...transactionQuery,
    createdAt: { $gte: today },
    paymentStatus: "completed",
  };
  const todaySales = await transactions.find(todayTransactionQuery).toArray();
  const todaySalesTotal = todaySales.reduce((sum, t) => sum + parseFloat(t.total || "0"), 0);
  const todayTransactions = todaySales.length;

  // Get yesterday's sales for comparison
  const yesterdayTransactionQuery = {
    ...transactionQuery,
    createdAt: { $gte: yesterday, $lt: today },
    paymentStatus: "completed",
  };
  const yesterdaySales = await transactions.find(yesterdayTransactionQuery).toArray();
  const yesterdaySalesTotal = yesterdaySales.reduce((sum, t) => sum + parseFloat(t.total || "0"), 0);

  // Calculate today's sales trend
  const todaySalesTrend = yesterdaySalesTotal > 0 
    ? ((todaySalesTotal - yesterdaySalesTotal) / yesterdaySalesTotal * 100).toFixed(1)
    : "0";

  // Get month's sales
  const monthTransactionQuery = {
    ...transactionQuery,
    createdAt: { $gte: monthStart },
    paymentStatus: "completed",
  };
  const monthSales = await transactions.find(monthTransactionQuery).toArray();
  const monthSalesTotal = monthSales.reduce((sum, t) => sum + parseFloat(t.total || "0"), 0);

  // Get total products count
  productQuery.status = "active";
  const totalProducts = await products.countDocuments(productQuery);

  // Get total customers count
  const totalCustomers = await customers.countDocuments(customerQuery);

  // Low stock count (สินค้าใกล้หมด): inventory ที่ quantity <= 10 สำหรับ products ของ org นี้
  const inventory = await getCollection<any>("inventory");
  const orgProductIds = await products.find(productQuery).project({ id: 1 }).toArray();
  const orgIds = orgProductIds.map((p: any) => p.id);
  const lowStockCount = orgIds.length === 0
    ? 0
    : await inventory.countDocuments({
        productId: { $in: orgIds },
        quantity: { $lte: 10 },
      });

  // Get recent activities
  const recentActivities = await activityLogs
    .find({})
    .sort({ createdAt: -1 })
    .limit(10)
    .toArray();

  return {
    todaySalesTotal,
    todaySalesTrend: parseFloat(todaySalesTrend),
    todayTransactions,
    monthSalesTotal,
    totalProducts,
    totalCustomers,
    lowStockCount,
    recentActivities,
  };
}

// ============ COMPANY PROFILE (ข้อมูลกิจการ) ============
export type CompanyProfileDoc = {
  id: number;
  name: string;
  taxId: string; // เลขผู้เสียภาษี 13 หลัก
  address: string;
  district?: string;
  province?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  businessType?: string; // ประเภทกิจการ
  vatRegistered: boolean; // จด VAT หรือไม่
  vatNumber?: string; // เลข VAT (ถ้ามี)
  organizationId: number; // เพิ่ม organizationId เพื่อแยกข้อมูล
  createdAt: Date;
  updatedAt: Date;
};

export async function getCompanyProfile(organizationId?: number | null) {
  const profiles = await getCollection<CompanyProfileDoc>("companyProfiles");
  const query: any = {};
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return profiles.findOne(query);
}

export async function upsertCompanyProfile(
  data: {
    name: string;
    taxId: string;
    address: string;
    district?: string;
    province?: string;
    postalCode?: string;
    phone?: string;
    email?: string;
    businessType?: string;
    vatRegistered: boolean;
    vatNumber?: string;
  },
  organizationId: number
) {
  const profiles = await getCollection<CompanyProfileDoc>("companyProfiles");
  const existing = await profiles.findOne({ organizationId });
  const now = new Date();
  
  if (existing) {
    await profiles.updateOne(
      { organizationId },
      { $set: { ...data, updatedAt: now } }
    );
    return profiles.findOne({ organizationId });
  } else {
    const id = await getNextSeq("companyProfiles");
    const doc: CompanyProfileDoc = {
      id,
      ...data,
      organizationId, // บันทึก organizationId
      createdAt: now,
      updatedAt: now,
    };
    await profiles.insertOne(doc);
    return doc;
  }
}

// ============ TAX INVOICES (ใบกำกับภาษี) ============
export type TaxInvoiceDoc = {
  id: number;
  invoiceNo: string; // เลขที่ใบกำกับภาษี
  invoiceType: "full" | "abbreviated"; // เต็มรูป / อย่างย่อ
  transactionId: number; // อ้างอิง transaction
  date: Date;
  customerName: string;
  customerTaxId?: string; // เลขผู้เสียภาษีลูกค้า (ถ้ามี)
  customerAddress?: string;
  subtotal: number; // ยอดก่อน VAT
  vat: number; // VAT 7%
  total: number; // ยอดรวม
  status: "draft" | "issued" | "cancelled";
  organizationId: number; // เพิ่ม organizationId เพื่อแยกข้อมูล
  issuedAt?: Date;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export async function createTaxInvoice(
  data: {
    invoiceNo: string;
    invoiceType: "full" | "abbreviated";
    transactionId: number;
    date: Date;
    customerName: string;
    customerTaxId?: string;
    customerAddress?: string;
    subtotal: number;
    vat: number;
    total: number;
  },
  organizationId: number
) {
  const invoices = await getCollection<TaxInvoiceDoc>("taxInvoices");
  const now = new Date();
  const id = await getNextSeq("taxInvoices");
  const doc: TaxInvoiceDoc = {
    id,
    ...data,
    organizationId, // บันทึก organizationId
    status: "issued",
    issuedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await invoices.insertOne(doc);
  return doc;
}

export async function getTaxInvoiceById(id: number, organizationId?: number | null) {
  const invoices = await getCollection<TaxInvoiceDoc>("taxInvoices");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return invoices.findOne(query);
}

export async function getTaxInvoiceByTransactionId(transactionId: number, organizationId?: number | null) {
  const invoices = await getCollection<TaxInvoiceDoc>("taxInvoices");
  const query: any = { transactionId };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return invoices.findOne(query);
}

export async function getTaxInvoicesByDateRange(startDate: Date, endDate: Date, organizationId?: number | null) {
  const invoices = await getCollection<TaxInvoiceDoc>("taxInvoices");
  const query: any = {
    date: { $gte: startDate, $lte: endDate },
    status: "issued",
  };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return invoices
    .find(query)
    .sort({ date: -1 })
    .toArray();
}

export async function cancelTaxInvoice(id: number, organizationId?: number | null) {
  const invoices = await getCollection<TaxInvoiceDoc>("taxInvoices");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  await invoices.updateOne(
    query,
    { $set: { status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() } }
  );
  return invoices.findOne(query);
}

// ============ VAT REPORTS (รายงานภาษีขาย/ซื้อ) ============
export type VatReportDoc = {
  id: number;
  month: string; // Format: "YYYY-MM"
  year: number;
  monthNumber: number;
  totalSales: number; // ยอดขายรวม
  vatSales: number; // VAT ขาย (7%)
  vatBuy: number; // VAT ซื้อ
  vatPay: number; // VAT ที่ต้องจ่าย (vatSales - vatBuy)
  status: "draft" | "submitted"; // สถานะการยื่น
  organizationId: number; // เพิ่ม organizationId เพื่อแยกข้อมูล
  submittedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export async function getVatReport(month: string, organizationId?: number | null) {
  const reports = await getCollection<VatReportDoc>("vatReports");
  const query: any = { month };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return reports.findOne(query);
}

export async function createOrUpdateVatReport(
  data: {
    month: string;
    totalSales: number;
    vatSales: number;
    vatBuy: number;
  },
  organizationId: number
) {
  const reports = await getCollection<VatReportDoc>("vatReports");
  const [year, monthNum] = data.month.split("-").map(Number);
  const vatPay = data.vatSales - data.vatBuy;
  const now = new Date();
  
  const existing = await reports.findOne({ month: data.month, organizationId });
  if (existing) {
    await reports.updateOne(
      { id: existing.id },
      {
        $set: {
          totalSales: data.totalSales,
          vatSales: data.vatSales,
          vatBuy: data.vatBuy,
          vatPay,
          updatedAt: now,
        },
      }
    );
    return reports.findOne({ id: existing.id });
  } else {
    const id = await getNextSeq("vatReports");
    const doc: VatReportDoc = {
      id,
      month: data.month,
      year,
      monthNumber: monthNum,
      totalSales: data.totalSales,
      vatSales: data.vatSales,
      vatBuy: data.vatBuy,
      vatPay,
      status: "draft",
      organizationId, // บันทึก organizationId
      createdAt: now,
      updatedAt: now,
    };
    await reports.insertOne(doc);
    return doc;
  }
}

export async function getVatReportsByYear(year: number, organizationId?: number | null) {
  const reports = await getCollection<VatReportDoc>("vatReports");
  const query: any = { year };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return reports
    .find(query)
    .sort({ monthNumber: 1 })
    .toArray();
}

export async function submitVatReport(month: string, organizationId?: number | null) {
  const reports = await getCollection<VatReportDoc>("vatReports");
  const query: any = { month };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  await reports.updateOne(
    query,
    { $set: { status: "submitted", submittedAt: new Date(), updatedAt: new Date() } }
  );
  return reports.findOne(query);
}

// ============ WITHHOLDING TAX (ภาษีหัก ณ ที่จ่าย) ============
export type WithholdingTaxDoc = {
  id: number;
  documentNo: string; // เลขที่หนังสือรับรอง
  documentType: "pnd3" | "pnd53"; // ภ.ง.ด.3 หรือ ภ.ง.ด.53
  payeeName: string; // ชื่อผู้รับเงิน
  payeeTaxId: string; // เลขผู้เสียภาษีผู้รับเงิน
  payeeAddress?: string;
  paymentDate: Date;
  paymentType: "service" | "rent" | "freelance" | "other"; // ประเภทการจ่าย
  paymentAmount: number; // จำนวนเงินที่จ่าย
  withholdingRate: number; // อัตราหัก (เช่น 3%, 5%)
  withholdingAmount: number; // จำนวนเงินหัก ณ ที่จ่าย
  netAmount: number; // จำนวนเงินสุทธิ
  status: "draft" | "issued" | "cancelled";
  issuedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export async function createWithholdingTax(data: {
  documentNo: string;
  documentType: "pnd3" | "pnd53";
  payeeName: string;
  payeeTaxId: string;
  payeeAddress?: string;
  paymentDate: Date;
  paymentType: "service" | "rent" | "freelance" | "other";
  paymentAmount: number;
  withholdingRate: number;
}) {
  const docs = await getCollection<WithholdingTaxDoc>("withholdingTaxes");
  const now = new Date();
  const id = await getNextSeq("withholdingTaxes");
  const withholdingAmount = (data.paymentAmount * data.withholdingRate) / 100;
  const netAmount = data.paymentAmount - withholdingAmount;
  
  const doc: WithholdingTaxDoc = {
    id,
    ...data,
    withholdingAmount,
    netAmount,
    status: "issued",
    issuedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await docs.insertOne(doc);
  return doc;
}

export async function getWithholdingTaxById(id: number) {
  const docs = await getCollection<WithholdingTaxDoc>("withholdingTaxes");
  return docs.findOne({ id });
}

export async function getWithholdingTaxesByDateRange(startDate: Date, endDate: Date) {
  const docs = await getCollection<WithholdingTaxDoc>("withholdingTaxes");
  return docs
    .find({
      paymentDate: { $gte: startDate, $lte: endDate },
      status: "issued",
    })
    .sort({ paymentDate: -1 })
    .toArray();
}

export async function getWithholdingTaxesByType(
  documentType: "pnd3" | "pnd53",
  year: number
) {
  const docs = await getCollection<WithholdingTaxDoc>("withholdingTaxes");
  const startDate = new Date(year, 0, 1);
  const endDate = new Date(year, 11, 31, 23, 59, 59);
  return docs
    .find({
      documentType,
      paymentDate: { $gte: startDate, $lte: endDate },
      status: "issued",
    })
    .sort({ paymentDate: 1 })
    .toArray();
}

// ============ ANNUAL INCOME SUMMARY (สรุปรายได้ประจำปี) ============
export type AnnualIncomeSummaryDoc = {
  id: number;
  year: number;
  totalRevenue: number; // รายได้รวม
  totalCost: number; // ต้นทุนรวม
  grossProfit: number; // กำไรขั้นต้น
  totalExpenses: number; // ค่าใช้จ่ายรวม
  netProfit: number; // กำไรสุทธิ
  status: "draft" | "finalized";
  finalizedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export async function getAnnualIncomeSummary(year: number) {
  const summaries = await getCollection<AnnualIncomeSummaryDoc>("annualIncomeSummaries");
  return summaries.findOne({ year });
}

export async function createOrUpdateAnnualIncomeSummary(data: {
  year: number;
  totalRevenue: number;
  totalCost: number;
  totalExpenses: number;
}) {
  const summaries = await getCollection<AnnualIncomeSummaryDoc>("annualIncomeSummaries");
  const grossProfit = data.totalRevenue - data.totalCost;
  const netProfit = grossProfit - data.totalExpenses;
  const now = new Date();
  
  const existing = await summaries.findOne({ year: data.year });
  if (existing) {
    await summaries.updateOne(
      { id: existing.id },
      {
        $set: {
          totalRevenue: data.totalRevenue,
          totalCost: data.totalCost,
          grossProfit,
          totalExpenses: data.totalExpenses,
          netProfit,
          updatedAt: now,
        },
      }
    );
    return summaries.findOne({ id: existing.id });
  } else {
    const id = await getNextSeq("annualIncomeSummaries");
    const doc: AnnualIncomeSummaryDoc = {
      id,
      year: data.year,
      totalRevenue: data.totalRevenue,
      totalCost: data.totalCost,
      grossProfit,
      totalExpenses: data.totalExpenses,
      netProfit,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    await summaries.insertOne(doc);
    return doc;
  }
}

export async function finalizeAnnualIncomeSummary(year: number) {
  const summaries = await getCollection<AnnualIncomeSummaryDoc>("annualIncomeSummaries");
  await summaries.updateOne(
    { year },
    { $set: { status: "finalized", finalizedAt: new Date(), updatedAt: new Date() } }
  );
  return summaries.findOne({ year });
}

// ============ PURCHASE INVOICES (ใบรับซื้อ) ============
export type PurchaseInvoiceDoc = {
  id: number;
  invoiceNo: string; // เลขที่ใบรับซื้อ
  supplierName: string; // ชื่อผู้ขาย
  supplierTaxId?: string; // เลขผู้เสียภาษีผู้ขาย
  supplierAddress?: string;
  date: Date;
  subtotal: number; // ยอดก่อน VAT
  vat: number; // VAT ซื้อ (7%)
  total: number; // ยอดรวม
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
  status: "draft" | "received" | "cancelled";
  organizationId: number; // เพิ่ม organizationId เพื่อแยกข้อมูล
  receivedAt?: Date;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export async function createPurchaseInvoice(
  data: {
    invoiceNo: string;
    supplierName: string;
    supplierTaxId?: string;
    supplierAddress?: string;
    date: Date;
    subtotal: number;
    vat: number;
    total: number;
    items: Array<{
      description: string;
      quantity: number;
      unitPrice: number;
      amount: number;
    }>;
  },
  organizationId: number
) {
  const invoices = await getCollection<PurchaseInvoiceDoc>("purchaseInvoices");
  const now = new Date();
  const id = await getNextSeq("purchaseInvoices");
  const doc: PurchaseInvoiceDoc = {
    id,
    ...data,
    organizationId, // บันทึก organizationId
    status: "received",
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await invoices.insertOne(doc);
  return doc;
}

export async function getPurchaseInvoiceById(id: number, organizationId?: number | null) {
  const invoices = await getCollection<PurchaseInvoiceDoc>("purchaseInvoices");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return invoices.findOne(query);
}

export async function getPurchaseInvoicesByDateRange(startDate: Date, endDate: Date, organizationId?: number | null) {
  const invoices = await getCollection<PurchaseInvoiceDoc>("purchaseInvoices");
  const query: any = {
    date: { $gte: startDate, $lte: endDate },
    status: "received",
  };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return invoices
    .find(query)
    .sort({ date: -1 })
    .toArray();
}

export async function cancelPurchaseInvoice(id: number, organizationId?: number | null) {
  const invoices = await getCollection<PurchaseInvoiceDoc>("purchaseInvoices");
  const query: any = { id };
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  await invoices.updateOne(
    query,
    { $set: { status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() } }
  );
  return invoices.findOne(query);
}

// ============ TOPPINGS ============
export type ToppingDoc = {
  id: number;
  name: string;
  price: number; // ราคาเป็น number (บาท)
  organizationId: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function getToppings(organizationId?: number | null) {
  const toppings = await getCollection<ToppingDoc>("toppings");
  const query: any = {};
  if (organizationId !== undefined && organizationId !== null) {
    query.organizationId = organizationId;
  }
  return toppings.find(query).sort({ createdAt: -1 }).toArray();
}

export async function getToppingById(id: number) {
  const toppings = await getCollection<ToppingDoc>("toppings");
  return toppings.findOne({ id });
}

export async function createTopping(data: {
  name: string;
  price: number;
  organizationId: number | null;
}) {
  const toppings = await getCollection<ToppingDoc>("toppings");
  const id = await getNextSeq("toppings");
  const now = new Date();
  const doc: ToppingDoc = {
    id,
    name: data.name,
    price: data.price,
    organizationId: data.organizationId,
    createdAt: now,
    updatedAt: now,
  };
  await toppings.insertOne(doc);
  return doc;
}

export async function updateTopping(id: number, data: {
  name?: string;
  price?: number;
}) {
  const toppings = await getCollection<ToppingDoc>("toppings");
  const updateData: any = { updatedAt: new Date() };
  if (data.name !== undefined) updateData.name = data.name;
  if (data.price !== undefined) updateData.price = data.price;
  await toppings.updateOne({ id }, { $set: updateData });
  return toppings.findOne({ id });
}

export async function deleteTopping(id: number) {
  const toppings = await getCollection<ToppingDoc>("toppings");
  await toppings.deleteOne({ id });
  return { success: true };
}

// ============ STORES (ห้องร้าน) ============
export type StoreSubscriptionStatus = "pending" | "active" | "disabled" | "expired";
export type SubscriptionPlan = "basic" | "premium";

export type StoreDoc = {
  id: number;
  storeCode: string; // รหัสร้าน (ใช้เข้าห้อง) เช่น "POS-UDON-2026"
  name: string; // ชื่อร้าน
  ownerId: number; // หัวหน้าร้าน (user id)
  // Subscription / Access control
  subscriptionStatus?: StoreSubscriptionStatus; // default: "active" (backward compatible)
  subscriptionPlan?: SubscriptionPlan; // default: "premium" (backward compatible)
  requestedAt?: Date | null; // สมัครร้าน/ขอใช้งาน
  activatedAt?: Date | null; // วันที่อนุมัติ/เปิดใช้งาน
  expiresAt?: Date | null; // วันหมดอายุ (null = ไม่หมดอายุ)
  disabledAt?: Date | null; // วันที่ปิดใช้งาน
  disabledReason?: string | null; // เหตุผล (ถ้ามี)
  expiredAt?: Date | null; // วันที่ถูก mark ว่าหมดอายุ
  createdAt: Date;
  updatedAt: Date;
};

export type StoreSubscriptionState = {
  storeId: number;
  status: StoreSubscriptionStatus;
  expiresAt: Date | null;
};

function normalizeSubscriptionStatus(v: unknown): StoreSubscriptionStatus {
  return v === "pending" || v === "active" || v === "disabled" || v === "expired" ? v : "active";
}

function normalizeSubscriptionPlan(v: unknown): SubscriptionPlan {
  return v === "basic" || v === "premium" ? v : "premium";
}

function toDateOrNull(v: unknown): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}

async function getStoresByIdAndOwnerId(storeId: number, ownerId: number): Promise<StoreDoc[]> {
  const stores = await getCollection<StoreDoc>("stores");
  return stores.find({ id: storeId, ownerId }).toArray();
}

export async function getOrgSubscriptionPlan(ownerId: number): Promise<SubscriptionPlan> {
  const stores = await getCollection<StoreDoc>("stores");
  const rows = await stores.find({ ownerId }).project({ subscriptionPlan: 1 }).toArray();
  // ถ้ามีอย่างน้อย 1 ร้านเป็น basic → ถือว่า org นี้เป็น basic (กันข้อมูลซ้ำ/ปน)
  for (const r of rows) {
    if (normalizeSubscriptionPlan((r as any)?.subscriptionPlan) === "basic") return "basic";
  }
  return "premium";
}

function computeStatusWithAutoExpire(
  rawStatus: StoreSubscriptionStatus,
  expiresAt: Date | null,
): { status: StoreSubscriptionStatus; shouldMarkExpired: boolean } {
  if (rawStatus === "active" && expiresAt && expiresAt.getTime() < Date.now()) {
    return { status: "expired", shouldMarkExpired: true };
  }
  return { status: rawStatus, shouldMarkExpired: false };
}

export async function getStoreSubscriptionState(storeId: number): Promise<StoreSubscriptionState> {
  const stores = await getCollection<StoreDoc>("stores");
  const store = await stores.findOne({ id: storeId });
  if (!store) {
    return { storeId, status: "disabled", expiresAt: null };
  }
  const expiresAt = toDateOrNull((store as any).expiresAt);
  const rawStatus = normalizeSubscriptionStatus((store as any).subscriptionStatus);

  // Auto-lock when expired (requirement: "ล็อกบัญชีอัตโนมัติเมื่อหมดอายุ")
  const computed = computeStatusWithAutoExpire(rawStatus, expiresAt);
  if (computed.shouldMarkExpired) {
    const now = new Date();
    await stores.updateOne(
      { id: storeId },
      { $set: { subscriptionStatus: "expired", expiredAt: now, updatedAt: now } },
    );
    return { storeId, status: "expired", expiresAt };
  }

  return { storeId, status: computed.status, expiresAt };
}

export async function getStoreSubscriptionForOrgStore(
  storeId: number,
  ownerId: number,
): Promise<StoreSubscriptionState & { subscriptionPlan: SubscriptionPlan }> {
  const stores = await getCollection<StoreDoc>("stores");
  const matches = await getStoresByIdAndOwnerId(storeId, ownerId);
  const orgPlan = await getOrgSubscriptionPlan(ownerId);
  if (matches.length === 0) {
    return { storeId, status: "disabled", expiresAt: null, subscriptionPlan: orgPlan };
  }
  // เลือก record ล่าสุด (กัน id ซ้ำหลายแถว)
  const store = matches.slice().sort((a: any, b: any) => {
    const at = (a?.updatedAt ? new Date(a.updatedAt).getTime() : 0) || 0;
    const bt = (b?.updatedAt ? new Date(b.updatedAt).getTime() : 0) || 0;
    return bt - at;
  })[0] as any;
  const expiresAt = toDateOrNull(store.expiresAt);
  const rawStatus = normalizeSubscriptionStatus(store.subscriptionStatus);

  const computed = computeStatusWithAutoExpire(rawStatus, expiresAt);
  if (computed.shouldMarkExpired) {
    const now = new Date();
    const code = String(store.storeCode || "").trim();
    if (code) {
      await stores.updateOne(
        { storeCode: code },
        { $set: { subscriptionStatus: "expired", expiredAt: now, updatedAt: now } },
      );
    }
  }

  return { storeId, status: computed.status, expiresAt, subscriptionPlan: orgPlan };
}

export async function updateStoreSubscription(
  storeId: number,
  patch: Partial<{
    subscriptionStatus: StoreSubscriptionStatus;
    expiresAt: Date | null;
    disabledReason: string | null;
  }>,
) {
  const stores = await getCollection<StoreDoc>("stores");
  const now = new Date();
  const update: Partial<StoreDoc> = { updatedAt: now };

  if (patch.subscriptionStatus !== undefined) {
    update.subscriptionStatus = patch.subscriptionStatus;
    if (patch.subscriptionStatus === "active") {
      update.activatedAt = now;
      update.disabledAt = null;
      update.disabledReason = null;
      update.expiredAt = null;
    }
    if (patch.subscriptionStatus === "disabled") {
      update.disabledAt = now;
      update.disabledReason = patch.disabledReason ?? null;
    }
    if (patch.subscriptionStatus === "expired") {
      update.expiredAt = now;
    }
  }

  if (patch.expiresAt !== undefined) {
    update.expiresAt = patch.expiresAt;
    // ถ้าตั้งวันหมดอายุย้อนหลัง => mark expired ทันที
    if (patch.expiresAt && patch.expiresAt.getTime() < Date.now()) {
      update.subscriptionStatus = "expired";
      update.expiredAt = now;
    }
  }

  if (patch.disabledReason !== undefined) {
    update.disabledReason = patch.disabledReason;
  }

  await stores.updateOne({ id: storeId }, { $set: update });
  return stores.findOne({ id: storeId });
}

export async function updateStoreSubscriptionByCode(
  storeCode: string,
  patch: Partial<{
    subscriptionStatus: StoreSubscriptionStatus;
    subscriptionPlan: SubscriptionPlan;
    expiresAt: Date | null;
    disabledReason: string | null;
  }>,
) {
  const stores = await getCollection<StoreDoc>("stores");
  const code = storeCode.trim();
  const existing = await stores.findOne({ storeCode: code });
  if (!existing) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `ไม่พบร้านจากโค้ด: ${code}` });
  }

  // IMPORTANT: ห้ามอิง id เพราะข้อมูลจริงอาจมี id ซ้ำ → จะอัปเดตผิดร้าน
  const now = new Date();
  const update: Partial<StoreDoc> = { updatedAt: now };

  if (patch.subscriptionStatus !== undefined) {
    update.subscriptionStatus = patch.subscriptionStatus;
    if (patch.subscriptionStatus === "active") {
      update.activatedAt = now;
      update.disabledAt = null;
      update.disabledReason = null;
      update.expiredAt = null;
    }
    if (patch.subscriptionStatus === "disabled") {
      update.disabledAt = now;
      update.disabledReason = patch.disabledReason ?? null;
    }
    if (patch.subscriptionStatus === "expired") {
      update.expiredAt = now;
    }
  }

  if (patch.expiresAt !== undefined) {
    update.expiresAt = patch.expiresAt;
    if (patch.expiresAt && patch.expiresAt.getTime() < Date.now()) {
      update.subscriptionStatus = "expired";
      update.expiredAt = now;
    }
  }

  if (patch.disabledReason !== undefined) {
    update.disabledReason = patch.disabledReason;
  }

  if (patch.subscriptionPlan !== undefined) {
    update.subscriptionPlan = patch.subscriptionPlan;
  }

  await stores.updateOne({ storeCode: code }, { $set: update });
  return stores.findOne({ storeCode: code });
}

export async function listAllStoresForSuperAdmin() {
  const stores = await getCollection<StoreDoc>("stores");
  const rows = await stores.find({}).sort({ createdAt: -1 }).toArray();

  // คำนวณสถานะจาก doc โดยตรง (ไม่อิง id) + auto-expire แบบอัปเดตด้วย storeCode
  const nowMs = Date.now();
  const out: Array<any> = [];
  for (const s of rows) {
    const expiresAt = toDateOrNull((s as any).expiresAt);
    const rawStatus = normalizeSubscriptionStatus((s as any).subscriptionStatus);
    const plan = normalizeSubscriptionPlan((s as any).subscriptionPlan);

    let computedStatus: StoreSubscriptionStatus = rawStatus;
    if (rawStatus === "active" && expiresAt && expiresAt.getTime() < nowMs) {
      computedStatus = "expired";
      const now = new Date();
      const code = String((s as any).storeCode || "").trim();
      if (code) {
        await stores.updateOne(
          { storeCode: code },
          { $set: { subscriptionStatus: "expired", expiredAt: now, updatedAt: now } },
        );
      }
    }

    out.push({
      ...s,
      computedStatus,
      computedExpiresAt: expiresAt,
      subscriptionPlan: plan,
    });
  }
  return out;
}

export async function assertCanCreateStaffUserForOrg(ownerId: number) {
  const plan = await getOrgSubscriptionPlan(ownerId);
  if (plan !== "basic") return;
  const users = await getCollection<UserDoc>("users");
  // NOTE: storeId ใน DB อาจซ้ำข้ามร้าน → ต้องนับแบบผูกกับ ownerId (organization)
  const count = await users.countDocuments({
    $or: [
      { organizationId: ownerId }, // staff ใน org นี้
      { id: ownerId, organizationId: null }, // owner ของ org นี้
    ],
  } as any);
  if (count >= 1) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "แพ็กเกจ Basic สร้างผู้ใช้งานได้ 1 บัญชีเท่านั้น (ไม่สามารถเพิ่มพนักงานได้)",
    });
  }
}

export async function assertCanJoinStoreByInvite(storeId: number, ownerId: number) {
  const plan = await getOrgSubscriptionPlan(ownerId);
  if (plan !== "basic") return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "แพ็กเกจ Basic ไม่รองรับการเพิ่มพนักงาน/การเข้าร้านด้วยรหัส",
  });
}

export async function assertCanManageStoreInvites(ownerId: number) {
  const plan = await getOrgSubscriptionPlan(ownerId);
  if (plan !== "basic") return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "แพ็กเกจ Basic ไม่รองรับการสร้าง/จัดการรหัสเข้าร้าน (พนักงาน)",
  });
}

/** POS guard: Login ได้ แต่กันการใช้งานเมื่อร้าน pending/expired/disabled */
export async function assertPosAccessForUser(user: { storeId?: number | null } | null) {
  const storeId = user?.storeId ?? null;
  if (!storeId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "กรุณาเชื่อมต่อร้านก่อน" });
  }
  const state = await getStoreSubscriptionState(Number(storeId));
  if (state.status === "active") return;
  if (state.status === "pending") {
    throw new TRPCError({ code: "FORBIDDEN", message: "บัญชีของคุณอยู่ระหว่างรอการอนุมัติ (pending)" });
  }
  if (state.status === "disabled") {
    throw new TRPCError({ code: "FORBIDDEN", message: "บัญชีของคุณถูกปิดใช้งาน (disabled)" });
  }
  // expired
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "บัญชีของคุณหมดอายุ กรุณาต่ออายุเพื่อใช้งานต่อ",
  });
}

export type StoreInviteDoc = {
  id: number;
  code: string; // รหัสเข้าห้องร้าน
  storeId: number; // อ้างอิงร้าน
  createdBy: number; // user id ที่สร้างรหัส
  active: boolean; // รหัสใช้งานได้หรือไม่
  createdAt: Date;
  updatedAt: Date;
};

// สร้างร้านใหม่ (สำหรับหัวหน้า)
export async function createStore(data: {
  storeCode: string;
  name: string;
  ownerId: number;
  subscriptionStatus?: StoreSubscriptionStatus;
  subscriptionPlan?: SubscriptionPlan;
  requestedAt?: Date | null;
}) {
  const stores = await getCollection<StoreDoc>("stores");
  
  // ตรวจสอบว่า storeCode ซ้ำหรือไม่
  const existing = await stores.findOne({ storeCode: data.storeCode });
  if (existing) {
    throw new Error(`รหัสร้าน "${data.storeCode}" ถูกใช้งานแล้ว`);
  }
  
  const now = new Date();
  const id = await getNextSeq("stores");
  const doc: StoreDoc = {
    id,
    storeCode: data.storeCode,
    name: data.name,
    ownerId: data.ownerId,
    subscriptionStatus: data.subscriptionStatus ?? "active",
    subscriptionPlan: data.subscriptionPlan ?? "premium",
    requestedAt: data.requestedAt ?? null,
    activatedAt: (data.subscriptionStatus ?? "active") === "active" ? now : null,
    expiresAt: null,
    disabledAt: null,
    disabledReason: null,
    expiredAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await stores.insertOne(doc);
  return doc;
}

// ดึงร้านตาม ID
export async function getStoreById(id: number) {
  const stores = await getCollection<StoreDoc>("stores");
  return stores.findOne({ id });
}

// ดึงร้านตาม storeCode
export async function getStoreByCode(storeCode: string) {
  const stores = await getCollection<StoreDoc>("stores");
  return stores.findOne({ storeCode });
}

// ดึงร้านทั้งหมดของ owner
export async function getStoresByOwner(ownerId: number) {
  const stores = await getCollection<StoreDoc>("stores");
  return stores.find({ ownerId }).sort({ createdAt: -1 }).toArray();
}

// สร้างรหัสเข้าร้าน (สำหรับหัวหน้า)
export async function createStoreInvite(data: {
  code: string;
  storeId: number;
  createdBy: number;
}) {
  const invites = await getCollection<StoreInviteDoc>("storeInvites");
  
  // ตรวจสอบว่า code ซ้ำหรือไม่
  const existing = await invites.findOne({ code: data.code });
  if (existing) {
    throw new Error(`รหัส "${data.code}" ถูกใช้งานแล้ว`);
  }
  
  const now = new Date();
  const id = await getNextSeq("storeInvites");
  const doc: StoreInviteDoc = {
    id,
    code: data.code,
    storeId: data.storeId,
    createdBy: data.createdBy,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await invites.insertOne(doc);
  return doc;
}

// ดึงรหัสเข้าร้านตาม code
export async function getStoreInviteByCode(code: string) {
  const invites = await getCollection<StoreInviteDoc>("storeInvites");
  return invites.findOne({ code, active: true });
}

// ดึงรหัสเข้าร้านทั้งหมดของร้าน
export async function getStoreInvitesByStore(storeId: number) {
  const invites = await getCollection<StoreInviteDoc>("storeInvites");
  return invites.find({ storeId }).sort({ createdAt: -1 }).toArray();
}

// อัปเดตสถานะรหัสเข้าร้าน
export async function updateStoreInvite(id: number, active: boolean) {
  const invites = await getCollection<StoreInviteDoc>("storeInvites");
  await invites.updateOne(
    { id },
    { $set: { active, updatedAt: new Date() } }
  );
  return invites.findOne({ id });
}

// พนักงานเข้าร้าน (อัปเดต storeId และ organizationId ของ user)
export async function joinStore(userId: number, storeId: number, organizationId: number) {
  const users = await getCollection<UserDoc>("users");
  await users.updateOne(
    { id: userId },
    { $set: { storeId, organizationId, updatedAt: new Date() } }
  );
  return users.findOne({ id: userId });
}

// พนักงานออกจากร้าน (ล้าง storeId และ organizationId)
export async function leaveStore(userId: number) {
  const users = await getCollection<UserDoc>("users");
  await users.updateOne(
    { id: userId },
    { $set: { storeId: null, organizationId: null, updatedAt: new Date() } }
  );
  return users.findOne({ id: userId });
}

// ดึงผู้ใช้ทั้งหมดในร้าน
export async function getUsersByStore(storeId: number) {
  const users = await getCollection<UserDoc>("users");
  return users.find({ storeId }).sort({ createdAt: 1 }).toArray();
}

// ============ SYSTEM CONFIG (รหัสหลักสำหรับระบบสร้างรหัสแอดมิน) ============
const MASTER_CODE_KEY = "masterCodeForAdminCodes";

/** คืนรหัสหลักที่ใช้ verify — ถ้า ORDERA_MASTER_CODE ใน env ไม่ว่าง ใช้ env ก่อน ไม่งั้นใช้จาก DB */
export async function getMasterCodeForAdminCodesForVerify(): Promise<string | null> {
  const fromEnv = (ENV.masterCodeForAdminCodes || "").trim();
  if (fromEnv !== "") return fromEnv;
  const col = await getCollection<{ _id: string; value: string }>("systemConfig");
  const row = await col.findOne({ _id: MASTER_CODE_KEY });
  const fromDb = row?.value != null && String(row.value).trim() !== "" ? String(row.value).trim() : "";
  return fromDb || null;
}

/** ดูว่ามีการตั้งรหัสหลักใน DB หรือยัง (สำหรับหน้า Settings) */
export async function getMasterCodeForAdminCodesConfig(): Promise<{ isConfigured: boolean }> {
  const col = await getCollection<{ _id: string; value: string }>("systemConfig");
  const row = await col.findOne({ _id: MASTER_CODE_KEY });
  const isConfigured = !!(row?.value && String(row.value).trim().length > 0);
  return { isConfigured };
}

/** ตั้ง/เปลี่ยนรหัสหลัก (ความยาวขั้นต่ำ 8) */
export async function setMasterCodeForAdminCodes(code: string): Promise<void> {
  const trimmed = code.trim();
  if (trimmed.length < 8) throw new Error("รหัสต้องมีอย่างน้อย 8 ตัวอักษร");
  const col = await getCollection<{ _id: string; value: string; updatedAt?: Date }>("systemConfig");
  await col.updateOne(
    { _id: MASTER_CODE_KEY },
    { $set: { value: trimmed, updatedAt: new Date() } },
    { upsert: true }
  );
}
