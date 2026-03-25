import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import {
  LayoutDashboard,
  LogOut,
  Users,
  BarChart3,
  Tag,
  ShoppingCart,
  Settings as SettingsIcon,
  Store,
  Receipt,
  History,
  Package,
  Palette,
  Shield,
  QrCode,
  Loader2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

// ========== Layout 3 แบบเท่านั้น ==========
// 1️⃣ MainLayout — Top Menu เสมอ ใช้กับ: Dashboard, รายงาน, สินค้า, ลูกค้า, พนักงาน, ตั้งค่า
// 2️⃣ POSLayout — Bottom Menu (ปุ่มขาย, พักบิล, เรียกบิล, ตะกร้า) ใช้กับ: หน้าขายเท่านั้น | ห้าม Fullscreen
// 3️⃣ FullscreenLayout — ไม่มีเมนู ใช้เฉพาะ: หน้าชำระเงิน, หน้าพิมพ์ใบเสร็จ, Export/Print | ห้ามใช้กับหน้าทั่วไป

/** เมนูด้านบน (MainLayout) */
const topNavItems = [
  { icon: LayoutDashboard, label: "ภาพรวมร้าน", path: "/", roles: ["superadmin", "admin", "manager", "cashier", "user"], requiresStore: false },
  { icon: Shield, label: "Super Admin", path: "/super-admin", roles: ["superadmin"], requiresStore: false },
  { icon: ShoppingCart, label: "ขายสินค้า", path: "/sales", roles: ["admin", "manager", "cashier"], requiresStore: true },
  { icon: QrCode, label: "QR สมัครสมาชิก", path: "/member-qr", roles: ["admin", "manager", "cashier"], requiresStore: true },
  { icon: Package, label: "จัดการสินค้า", path: "/products", roles: ["admin", "manager"], requiresStore: true },
  { icon: Users, label: "ลูกค้า", path: "/customers", roles: ["admin", "manager"], requiresStore: true },
  { icon: Tag, label: "ส่วนลด", path: "/discounts", roles: ["admin", "manager"], requiresStore: true },
  { icon: BarChart3, label: "รายงานยอดขาย", path: "/reports", roles: ["admin", "manager"], requiresStore: true },
  { icon: SettingsIcon, label: "ตั้งค่า", path: "/settings", roles: ["admin"], requiresStore: false },
  { icon: Store, label: "เข้าร้าน", path: "/join-store", roles: ["cashier"], requiresStore: false, showOnlyWhenNoStore: true },
];

function filterMenuByUser(
  items: typeof topNavItems,
  user: { role?: string; storeId?: number | null; organizationId?: number | null } | null
) {
  if (!user) return [];
  return items.filter((item) => {
    if (item.roles && (!user.role || !item.roles.includes(user.role))) return false;
    if (item.showOnlyWhenNoStore) return !user.storeId;
    if (item.requiresStore) {
      if ((user.role === "admin" || user.role === "manager") && !user.organizationId) return true;
      return !!user.storeId;
    }
    return true;
  });
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { loading, user, logout } = useAuth();

  // Global access lock: ถ้าร้านไม่ active จะเข้า "ทุกหน้า" ไม่ได้ (ตาม requirement ล่าสุด)
  const subscriptionQuery = trpc.subscription.my.useQuery(undefined, {
    enabled: !!user && user.role !== "superadmin" && !!user.storeId,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (user?.role === "user" && !user?.storeId) {
      const allowed = ["/", "/signup-store", "/login", "/register"];
      if (!allowed.includes(location)) setLocation("/");
      return;
    }
    if (user?.role === "cashier" && !user?.storeId && location !== "/join-store" && location !== "/login") {
      setLocation("/join-store");
    } else if (user?.role === "cashier" && user?.storeId && location !== "/sales" && location !== "/join-store") {
      setLocation("/sales");
    }
  }, [location, setLocation, user?.role, user?.storeId]);

  if (loading) return <DashboardLayoutSkeleton />;

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex w-full max-w-md flex-col items-center gap-8 p-8">
          <div className="flex flex-col items-center gap-6">
            <h1 className="text-center text-2xl font-semibold tracking-tight">Sign in to continue</h1>
            <p className="max-w-sm text-center text-sm text-muted-foreground">
              Access to this dashboard requires authentication.
            </p>
          </div>
          <div className="flex w-full flex-col gap-3">
            <Button size="lg" className="w-full shadow-lg" onClick={() => setLocation("/login")}>
              Sign in with password
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="w-full"
              onClick={() => {
                const loginUrl = getLoginUrl();
                if (!loginUrl) {
                  alert("OAuth is not configured.");
                  return;
                }
                window.location.href = loginUrl;
              }}
            >
              Sign in with OAuth
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Super Admin ไม่ถูกล็อกด้วยสถานะร้าน
  if (user.role !== "superadmin" && user.storeId) {
    if (subscriptionQuery.isLoading) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background px-4">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            กำลังตรวจสอบสถานะการใช้งาน...
          </div>
        </div>
      );
    }

    const status = (subscriptionQuery.data as any)?.status as
      | "active"
      | "pending"
      | "expired"
      | "disabled"
      | undefined;

    if (status && status !== "active") {
      const msg =
        status === "expired"
          ? "บัญชีของคุณหมดอายุ กรุณาต่ออายุเพื่อใช้งานต่อ"
          : status === "pending"
            ? "บัญชีของคุณอยู่ระหว่างรอการอนุมัติ (pending)"
            : "บัญชีของคุณถูกปิดใช้งาน (disabled)";

      return (
        <div className="min-h-screen flex items-center justify-center bg-background px-4">
          <div className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-sm space-y-4">
            <div className="text-xl font-bold">ไม่สามารถเข้าใช้งานระบบได้</div>
            <div className="text-muted-foreground">{msg}</div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="outline" onClick={() => window.location.reload()}>
                โหลดใหม่
              </Button>
              <Button
                onClick={() => {
                  logout();
                }}
              >
                ออกจากระบบ
              </Button>
            </div>
          </div>
        </div>
      );
    }
  }

  if (user.role === "cashier" && location !== "/sales") return null;

  const menuItems = filterMenuByUser(topNavItems, user);

  return (
    <MainLayout user={user} menuItems={menuItems} setLocation={setLocation}>
      {children}
    </MainLayout>
  );
}

/** 1️⃣ MainLayout — มี Top Menu เสมอ ใช้กับ Dashboard, รายงาน, สินค้า, ลูกค้า, พนักงาน, ตั้งค่า */
function MainLayout({
  user,
  menuItems,
  setLocation,
  children,
}: {
  user: { name?: string | null; email?: string | null };
  menuItems: typeof topNavItems;
  setLocation: (path: string) => void;
  children: React.ReactNode;
}) {
  const [location] = useLocation();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const { logout } = useAuth();

  return (
    <div className="min-h-screen bg-white">
      {/* MainLayout: Top Menu เสมอ — ห้ามซ่อน */}
      <header className="sticky top-0 z-50 flex min-h-[64px] items-center justify-between border-b bg-sidebar px-3 sm:px-4 text-sidebar-foreground shadow-sm">
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          <img src="/ordera-logo-white.svg" alt="Ordera" className="h-8 w-8 drop-shadow-lg" />
          <span className="text-lg font-bold tracking-tight text-sidebar-foreground drop-shadow-md hidden sm:inline">
            Ordera
          </span>
        </div>
        <nav className="flex flex-1 justify-center gap-2 sm:gap-3 px-2 sm:px-4 min-h-[48px] items-center">
          {menuItems.map((item) => {
            const isActive =
              location === item.path ||
              (item.path !== "/" && location.startsWith(item.path + "/"));
            return (
              <button
                key={item.path}
                type="button"
                title={item.label}
                onClick={() => setLocation(item.path)}
                className={cn(
                  "flex items-center justify-center rounded-xl min-h-[48px] min-w-[48px] p-3 text-sm font-medium transition-colors touch-manipulation active:scale-95",
                  isActive
                    ? "bg-sidebar-accent text-white"
                    : "text-sidebar-foreground/90 hover:bg-sidebar-accent/80 hover:text-white"
                )}
              >
                <item.icon className="h-6 w-6 shrink-0" />
              </button>
            );
          })}
        </nav>
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 rounded-xl min-h-[48px] min-w-[48px] sm:min-w-0 sm:px-3 justify-center p-2 hover:bg-sidebar-accent/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation">
                <Avatar className="h-8 w-8 border">
                  <AvatarFallback className="text-xs">
                    {user?.name?.charAt(0).toUpperCase() ?? "?"}
                  </AvatarFallback>
                </Avatar>
                <span className="max-w-[120px] truncate text-sm text-sidebar-foreground hidden md:inline">
                  {user?.name ?? "-"}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onClick={() => setLocation("/theme")}
                className="cursor-pointer"
              >
                <Palette className="mr-2 h-4 w-4" />
                ธีมสี
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setShowLogoutConfirm(true)}
                className="cursor-pointer text-destructive focus:text-destructive"
              >
                <LogOut className="mr-2 h-4 w-4" />
                ออกจากระบบ
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="sm"
            className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-white hidden sm:flex"
            onClick={() => setShowLogoutConfirm(true)}
          >
            <LogOut className="h-4 w-4 mr-1" />
            ออก
          </Button>
        </div>
      </header>
      <main className="flex-1 p-4 min-h-[calc(100vh-64px)]">{children}</main>
      <AlertDialog open={showLogoutConfirm} onOpenChange={setShowLogoutConfirm}>
        <AlertDialogContent className="max-w-sm border p-0 overflow-hidden">
          <div className="flex justify-center bg-sidebar py-5">
            <img src="/ordera-logo-white.svg" alt="Ordera" className="h-14 w-14 drop-shadow-lg" />
          </div>
          <AlertDialogHeader className="p-6 pt-5 text-center">
            <AlertDialogTitle>ยืนยันการออกจากระบบ</AlertDialogTitle>
            <AlertDialogDescription>คุณแน่ใจหรือว่าต้องการออกจากระบบ?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="p-6 pt-0 flex flex-row gap-3 justify-center">
            <AlertDialogCancel>ยกเลิก</AlertDialogCancel>
            <Button
              className="bg-sidebar text-sidebar-foreground hover:bg-sidebar-accent"
              onClick={() => {
                setShowLogoutConfirm(false);
                logout();
              }}
            >
              ตกลง
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 2️⃣ POSLayout — มี Bottom Menu (ปุ่มขาย, พักบิล, เรียกบิล, ตะกร้า) ใช้กับหน้าขายเท่านั้น | ไม่มี Top Menu | ห้าม Fullscreen */
function POSLayout({
  user,
  setLocation,
  children,
}: {
  user: { name?: string | null };
  setLocation: (path: string) => void;
  children: React.ReactNode;
}) {
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const { logout } = useAuth();

  const emitPOSAction = (action: "park-bill" | "recall-bill" | "cart" | "sell") => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pos-bar-action", { detail: action }));
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* POS: แถบบนมินิมอล (ไม่มี Top Menu แบบ MainLayout) */}
      <header className="flex h-14 min-h-[56px] shrink-0 items-center justify-between border-b bg-sidebar px-4 text-sidebar-foreground">
        <div className="flex items-center gap-3">
          <img src="/ordera-logo-white.svg" alt="Ordera" className="h-8 w-8 drop-shadow-lg" />
          <span className="font-bold tracking-tight text-sidebar-foreground">Ordera</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-sidebar-foreground max-w-[140px]">{user?.name ?? "-"}</span>
          <Button
            variant="ghost"
            size="sm"
            className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-white"
            onClick={() => setShowLogoutConfirm(true)}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">{children}</main>
      {/* POS Bottom Menu — ปุ่มขาย, พักบิล, เรียกบิล, ตะกร้า (หน้าขายห้ามซ่อน) */}
      <footer className="shrink-0 border-t bg-sidebar text-sidebar-foreground safe-area-pb">
        <div className="flex h-14 min-h-[56px] items-center justify-around px-2">
          <button
            type="button"
            onClick={() => emitPOSAction("sell")}
            className="flex flex-col items-center gap-0.5 rounded-lg px-3 py-2 text-xs font-medium hover:bg-sidebar-accent/80 min-h-[var(--touch-target)]"
          >
            <Store className="h-5 w-5" />
            <span>ขาย</span>
          </button>
          <button
            type="button"
            onClick={() => emitPOSAction("park-bill")}
            className="flex flex-col items-center gap-0.5 rounded-lg px-3 py-2 text-xs font-medium hover:bg-sidebar-accent/80 min-h-[var(--touch-target)]"
          >
            <Receipt className="h-5 w-5" />
            <span>พักบิล</span>
          </button>
          <button
            type="button"
            onClick={() => emitPOSAction("recall-bill")}
            className="flex flex-col items-center gap-0.5 rounded-lg px-3 py-2 text-xs font-medium hover:bg-sidebar-accent/80 min-h-[var(--touch-target)]"
          >
            <History className="h-5 w-5" />
            <span>เรียกบิล</span>
          </button>
          <button
            type="button"
            onClick={() => emitPOSAction("cart")}
            className="flex flex-col items-center gap-0.5 rounded-lg px-3 py-2 text-xs font-medium hover:bg-sidebar-accent/80 min-h-[var(--touch-target)]"
          >
            <ShoppingCart className="h-5 w-5" />
            <span>ตะกร้า</span>
          </button>
        </div>
      </footer>
      <AlertDialog open={showLogoutConfirm} onOpenChange={setShowLogoutConfirm}>
        <AlertDialogContent className="max-w-sm border p-0 overflow-hidden">
          <div className="flex justify-center bg-sidebar py-5">
            <img src="/ordera-logo-white.svg" alt="Ordera" className="h-14 w-14 drop-shadow-lg" />
          </div>
          <AlertDialogHeader className="p-6 pt-5 text-center">
            <AlertDialogTitle>ยืนยันการออกจากระบบ</AlertDialogTitle>
            <AlertDialogDescription>คุณแน่ใจหรือว่าต้องการออกจากระบบ?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="p-6 pt-0 flex flex-row gap-3 justify-center">
            <AlertDialogCancel>ยกเลิก</AlertDialogCancel>
            <Button
              className="bg-sidebar text-sidebar-foreground hover:bg-sidebar-accent"
              onClick={() => {
                setShowLogoutConfirm(false);
                logout();
              }}
            >
              ตกลง
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 3️⃣ FullscreenLayout — ไม่มีเมนู ใช้เฉพาะ: หน้าชำระเงิน, หน้าพิมพ์ใบเสร็จ, Export/Print | ห้ามใช้กับหน้าขาย/รายงาน/จัดการข้อมูล */
export function FullscreenLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-white">{children}</div>;
}
