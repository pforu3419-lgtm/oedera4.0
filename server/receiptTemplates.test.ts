import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAdminContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "admin-user",
    email: "admin@example.com",
    name: "Admin User",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("receiptTemplates", () => {
  it("should list receipt templates", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.receiptTemplates.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("should create a receipt template", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.receiptTemplates.create({
      name: "Test Template",
      headerText: "Welcome to our store",
      footerText: "Thank you for your purchase",
      showCompanyName: true,
      showDate: true,
      showTime: true,
      showCashier: true,
      showTransactionId: true,
      isDefault: false,
    });

    expect(result).toBeDefined();
    expect(result.name).toBe("Test Template");
  });

  it("should get a receipt template", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    const created = await caller.receiptTemplates.create({
      name: "Get Test Template",
      headerText: "Header",
      footerText: "Footer",
      showCompanyName: true,
      showDate: true,
      showTime: true,
      showCashier: true,
      showTransactionId: true,
      isDefault: false,
    });

    const result = await caller.receiptTemplates.get({
      id: created.id,
    });

    expect(result).toBeDefined();
    expect(result?.name).toBe("Get Test Template");
  });

  it("should update a receipt template", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    const created = await caller.receiptTemplates.create({
      name: "Update Test Template",
      headerText: "Original Header",
      footerText: "Original Footer",
      showCompanyName: true,
      showDate: true,
      showTime: true,
      showCashier: true,
      showTransactionId: true,
      isDefault: false,
    });

    const result = await caller.receiptTemplates.update({
      id: created.id,
      name: "Updated Template",
      headerText: "Updated Header",
    });

    expect(result).toBeDefined();
    expect(result.name).toBe("Updated Template");
    expect(result.headerText).toBe("Updated Header");
  });

  it("should delete a receipt template", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    const created = await caller.receiptTemplates.create({
      name: "Delete Test Template",
      headerText: "Header",
      footerText: "Footer",
      showCompanyName: true,
      showDate: true,
      showTime: true,
      showCashier: true,
      showTransactionId: true,
      isDefault: false,
    });

    const result = await caller.receiptTemplates.delete({
      id: created.id,
    });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
  });

  it("should get default receipt template", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    // Create a default template
    await caller.receiptTemplates.create({
      name: "Default Template",
      headerText: "Header",
      footerText: "Footer",
      showCompanyName: true,
      showDate: true,
      showTime: true,
      showCashier: true,
      showTransactionId: true,
      isDefault: true,
    });

    const result = await caller.receiptTemplates.getDefault();
    expect(result).toBeDefined();
    expect(result?.isDefault).toBe(true);
  });

  it("should handle template with all fields", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.receiptTemplates.create({
      name: "Full Template",
      headerText: "Welcome to ABC Store\nOpening Hours: 9AM - 9PM",
      footerText: "Thank you for your purchase\nPlease visit us again",
      showCompanyName: true,
      showDate: true,
      showTime: true,
      showCashier: true,
      showTransactionId: true,
      isDefault: false,
    });

    expect(result).toBeDefined();
    expect(result.name).toBe("Full Template");
    expect(result.headerText).toContain("Welcome");
    expect(result.footerText).toContain("Thank you");
  });

  it("should handle template with minimal fields", async () => {
    const ctx = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.receiptTemplates.create({
      name: "Minimal Template",
    });

    expect(result).toBeDefined();
    expect(result.name).toBe("Minimal Template");
    expect(result.headerText).toBeNull();
    expect(result.footerText).toBeNull();
  });
});
