import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import Home from "@/pages/Home";
import Sales from "@/pages/Sales";
import Products from "@/pages/Products";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Customers from "./pages/Customers";
import Reports from "./pages/Reports";
import Discounts from "./pages/Discounts";
import Login from "./pages/Login";
import Register from "./pages/Register";
import StoreSignup from "./pages/StoreSignup";
import Settings from "./pages/Settings";
import StoreSettingsPage from "./pages/StoreSettingsPage";
import ThemeSettingsPage from "./pages/ThemeSettingsPage";
import TaxSystem from "./pages/TaxSystem";
import Toppings from "./pages/Toppings";
import JoinStore from "./pages/JoinStore";
import SuperAdminDashboard from "./pages/SuperAdminDashboard";
import SuperAdminLogin from "./pages/SuperAdminLogin";
import MemberSignupPage from "./pages/MemberSignupPage";
import MemberQrPage from "./pages/MemberQrPage";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { useEffect, useMemo, useState } from "react";
import {
  THEME_CHANGED_EVENT,
  applyThemePrimaryColor,
  readUserThemePreference,
  type ThemeMode,
} from "@/lib/theme";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path={"/login"} component={Login} />
      <Route path={"/register"} component={Register} />
      <Route path={"/signup-store"} component={StoreSignup} />
      <Route path={"/m/:storeId"} component={MemberSignupPage} />
      <Route path={"/sales"} component={Sales} />
      <Route path={"/products"} component={Products} />
      <Route path={"/inventory"} component={Products} />
      <Route path={"/customers"} component={Customers} />
      <Route path={"/loyalty"} component={Customers} />
      <Route path={"/reports"} component={Reports} />
      <Route path={"/discounts"} component={Discounts} />
      <Route path={"/users"} component={Settings} />
      <Route path={"/receipt-templates"} component={Settings} />
      <Route path={"/settings"} component={Settings} />
      <Route path={"/store-settings"} component={StoreSettingsPage} />
      <Route path={"/theme"} component={ThemeSettingsPage} />
      <Route path={"/super-admin/login"} component={SuperAdminLogin} />
      <Route path={"/super-admin"} component={SuperAdminDashboard} />
      <Route path={"/member-qr"} component={MemberQrPage} />
      <Route path={"/tax/company-profile"} component={TaxSystem} />
      <Route path={"/tax/invoices"} component={TaxSystem} />
      <Route path={"/tax/vat-reports"} component={TaxSystem} />
      <Route path={"/tax/purchase-invoices"} component={TaxSystem} />
      <Route path={"/tax"} component={TaxSystem} />
      <Route path={"/toppings"} component={Toppings} />
      <Route path={"/join-store"} component={JoinStore} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const { user } = useAuth();
  const { data: storeSettings } = trpc.storeSettings.get.useQuery(undefined, {
    enabled: !!user?.storeId,
  });

  const [userPrefTick, setUserPrefTick] = useState(0);
  useEffect(() => {
    const onChange = () => setUserPrefTick((x) => x + 1);
    window.addEventListener(THEME_CHANGED_EVENT, onChange as EventListener);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(THEME_CHANGED_EVENT, onChange as EventListener);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const effective = useMemo(() => {
    const userPref = readUserThemePreference();
    const storePrimary = (storeSettings?.primaryColor || "").trim();
    const storeMode = (storeSettings?.themeMode || "").trim() as ThemeMode | "";

    const userEnabled = Boolean(userPref?.enabled);
    const primaryColor = userEnabled
      ? (userPref?.primaryColor || "").trim() || undefined
      : storePrimary || undefined;
    const themeMode: ThemeMode | undefined = userEnabled
      ? userPref?.themeMode
      : storeMode === "light" || storeMode === "dark"
        ? storeMode
        : undefined;

    // foregroundMode มีผลกับความอ่านง่าย จึงอนุญาตให้ตั้งได้แม้ไม่ได้เปิด "ธีมส่วนตัว"
    const foregroundMode = (userPref as any)?.foregroundMode;

    return { primaryColor, themeMode, foregroundMode };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeSettings?.primaryColor, storeSettings?.themeMode, userPrefTick]);

  useEffect(() => {
    // Apply color theme (inline CSS vars) — ไม่กระทบ logic POS
    applyThemePrimaryColor(effective.primaryColor, { foregroundMode: effective.foregroundMode });
  }, [effective.primaryColor, effective.foregroundMode]);

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" forcedTheme={effective.themeMode}>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
