import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import React, { useEffect, useMemo, useReducer, useState } from "react";
import { Loader2, X, Search, Clock, DollarSign, User, History, Printer, Check } from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";

interface CartItem {
  productId: number;
  name: string;
  price: string;
  quantity: number;
  subtotal: number;
  imageUrl?: string;
  toppings?: Array<{ id: number; name: string; price: number }>; // ท็อปปิ้งที่เลือก
}

interface SelectedCustomer {
  id: number;
  name: string;
  phone: string;
  loyaltyPoints: number;
}

type CartAction =
  | { type: "ADD"; product: any; toppings: Array<{ id: number; name: string; price: number }>; priceOverride?: number }
  | { type: "REMOVE"; productId: number; name: string }
  | { type: "UPDATE_QTY"; productId: number; quantity: number }
  | { type: "CLEAR" };

function cartReducer(state: CartItem[], action: CartAction): CartItem[] {
  switch (action.type) {
    case "ADD": {
      const { product, toppings, priceOverride } = action;
      const productId = Number(product.id);
      const basePrice = priceOverride != null ? priceOverride : parseFloat(product.price);
      const toppingsTotal = toppings.reduce((sum, t) => sum + t.price, 0);
      const itemPrice = basePrice + toppingsTotal;
      const tops = toppings;
      const topsKey = JSON.stringify((tops || []).slice().sort((a, b) => a.id - b.id));
      // รวมรายการเดียวกัน: productId + ราคาต่อหน่วย + toppings (ไม่ใช้ name เพื่อกัน name เปลี่ยนแล้วไม่ merge)
      const existing = state.find(
        (item) =>
          item.productId === productId &&
          parseFloat(item.price).toFixed(2) === itemPrice.toFixed(2) &&
          JSON.stringify((item.toppings || []).slice().sort((a, b) => a.id - b.id)) === topsKey
      );
      if (existing) {
        return state.map((item) =>
          item.productId === productId &&
          parseFloat(item.price).toFixed(2) === itemPrice.toFixed(2) &&
          JSON.stringify((item.toppings || []).slice().sort((a, b) => a.id - b.id)) === topsKey
            ? {
                ...item,
                quantity: item.quantity + 1,
                subtotal: (item.quantity + 1) * itemPrice,
              }
            : item
        );
      }
      return [
        ...state,
        {
          productId,
          name: product.name,
          price: itemPrice.toFixed(2),
          quantity: 1,
          subtotal: itemPrice,
          imageUrl: product.imageUrl,
          toppings: tops.length > 0 ? tops : undefined,
        },
      ];
    }
    case "REMOVE":
      return state.filter(
        (item) => !(item.productId === action.productId && item.name === action.name)
      );
    case "UPDATE_QTY": {
      const { productId, quantity } = action;
      if (quantity <= 0) {
        return state.filter((item) => item.productId !== productId);
      }
      return state.map((item) =>
        item.productId === productId
          ? {
              ...item,
              quantity,
              subtotal: quantity * parseFloat(item.price),
            }
          : item
      );
    }
    case "CLEAR":
      return [];
    default:
      return state;
  }
}

export default function Sales() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const [cart, dispatchCart] = useReducer(cartReducer, []);
  // รับ event จาก POS Bottom Bar (ขาย, พักบิล, เรียกบิล, ตะกร้า) — หน้าขายใช้ POSLayout ห้าม Fullscreen
  useEffect(() => {
    const handler = (e: CustomEvent<string>) => {
      const action = e.detail;
      if (action === "cart") {
        document.querySelector("[data-pos-cart-panel]")?.scrollIntoView({ behavior: "smooth" });
      }
      // พักบิล / เรียกบิล — ต่อเมื่อมี handler จริงจะเชื่อมตรงนี้
    };
    window.addEventListener("pos-bar-action", handler as EventListener);
    return () => window.removeEventListener("pos-bar-action", handler as EventListener);
  }, []);
  const [selectedCategory, setSelectedCategory] = useState<number | undefined>();
  const [searchTerm, setSearchTerm] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "transfer" | "card">("cash");
  const [paymentAmount, setPaymentAmount] = useState<string>("");
  const [showReceipt, setShowReceipt] = useState(false);
  const [lastTransaction, setLastTransaction] = useState<any>(null);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [tempPaymentAmount, setTempPaymentAmount] = useState<string>("");

  // Tax toggle (เฉพาะหน้าขาย): เปิด/ปิดระบบคำนวณภาษีตอนจ่ายเงิน
  const orgId = user ? (user.organizationId ?? user.id) : null;
  const taxKey = useMemo(
    () => `ordera:salesTaxEnabled:${orgId ?? "unknown"}`,
    [orgId],
  );
  const [taxEnabled, setTaxEnabled] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("ordera:salesTaxEnabled");
      // legacy fallback (old key)
      if (v != null) return v !== "0";
    } catch {
      // ignore
    }
    return true;
  });
  useEffect(() => {
    try {
      const v = localStorage.getItem(taxKey);
      if (v != null) setTaxEnabled(v !== "0");
      else setTaxEnabled(true);
    } catch {
      setTaxEnabled(true);
    }
  }, [taxKey]);
  useEffect(() => {
    try {
      localStorage.setItem(taxKey, taxEnabled ? "1" : "0");
    } catch {
      // ignore
    }
  }, [taxKey, taxEnabled]);
  
  // Customer & Discount states
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [showCustomerSearch, setShowCustomerSearch] = useState(false);
  const [discountAmount, setDiscountAmount] = useState<string>("0");
  const [redeemPoints, setRedeemPoints] = useState<string>("0");
  const [discountCode, setDiscountCode] = useState<string>("");
  const [appliedDiscount, setAppliedDiscount] = useState<any>(null);
  const [discountFromCode, setDiscountFromCode] = useState<number>(0);

  // Toppings state
  const [showToppingDialog, setShowToppingDialog] = useState(false);
  const [selectedProductForTopping, setSelectedProductForTopping] = useState<any>(null);
  const [selectedToppings, setSelectedToppings] = useState<Array<{ id: number; name: string; price: number }>>([]);

  // สแกน QR/Barcode — โฟกัสช่องรับอัตโนมัติ ไม่ต้องคลิกก่อนสแกน
  const [scanInput, setScanInput] = useState("");
  const scanInputRef = React.useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  
  // Subscription / POS access (สำคัญ: หมดอายุ/รออนุมัติ => Login ได้ แต่เข้า POS ไม่ได้)
  const subscriptionQuery = trpc.subscription.my.useQuery(undefined, { enabled: !!user });
  const posAllowed = (subscriptionQuery.data as any)?.status === "active";

  // Queries (เปิดใช้งานเฉพาะตอนเข้าถึง POS ได้)
  const categoriesQuery = trpc.categories.list.useQuery(undefined, { enabled: posAllowed });
  const productsQuery = trpc.products.list.useQuery(
    {
      categoryId: selectedCategory,
      search: searchTerm,
    },
    { enabled: posAllowed }
  );
  const toppingsQuery = trpc.toppings.list.useQuery(undefined, { enabled: posAllowed });
  const customersQuery = trpc.customers.list.useQuery(
    {
      search: customerSearch || undefined, // ถ้าเป็น empty string ให้เป็น undefined เพื่อแสดงทั้งหมด
    },
    { enabled: posAllowed }
  );
  const createTransactionMutation = trpc.transactions.create.useMutation();
  const activeDiscountsQuery = trpc.discounts.active.useQuery(undefined, { enabled: posAllowed });
  const validateDiscountCodeQuery = trpc.discountCodes.validate.useQuery(
    { code: discountCode.trim() },
    { enabled: false }
  );
  const receiptTemplateQuery = trpc.receiptTemplates.getDefault.useQuery(undefined, { enabled: posAllowed });

  // Store Settings (สำหรับแสดงชื่อร้าน/โลโก้บน header เท่านั้น)
  const { data: storeSettings } = trpc.storeSettings.get.useQuery(undefined, {
    enabled: !!user?.storeId,
  });
  const headerStoreName = (storeSettings?.storeName || "").trim() || "Ordera";
  const headerLogoSrc = (storeSettings?.logoUrl || "").trim() || "/ordera-logo-white.svg";

  const categories = categoriesQuery.data || [];
  const products = productsQuery.data || [];
  const customers = customersQuery.data || [];

  const computeDiscountAmount = (
    discountInfo: any,
    baseSubtotal: number,
    items: CartItem[]
  ) => {
    let amount = 0;
    if (discountInfo.type === "percentage") {
      amount = (baseSubtotal * parseFloat(discountInfo.value)) / 100;
    } else if (
      discountInfo.type === "fixed_amount" ||
      discountInfo.type === "bill_total"
    ) {
      amount = parseFloat(discountInfo.value);
    } else if (discountInfo.type === "product_specific") {
      const targetTotal = items
        .filter(
          item => item.productId.toString() === discountInfo.productId
        )
        .reduce((sum, item) => sum + item.subtotal, 0);
      amount = Math.min(parseFloat(discountInfo.value), targetTotal);
    }

    if (discountInfo.maxDiscountAmount) {
      const maxAmount = parseFloat(discountInfo.maxDiscountAmount);
      amount = Math.min(amount, maxAmount);
    }

    return Math.max(0, amount);
  };

  // Cart operations
  const addToCart = (product: any) => {
    // เปิด dialog เลือกท็อปปิ้งก่อนเพิ่มสินค้า
    setSelectedProductForTopping(product);
    setSelectedToppings([]);
    setShowToppingDialog(true);
  };

  const handleConfirmToppings = () => {
    if (!selectedProductForTopping) return;
    const product = selectedProductForTopping;
    dispatchCart({ type: "ADD", product, toppings: selectedToppings });
    setShowToppingDialog(false);
    setSelectedProductForTopping(null);
    setSelectedToppings([]);
    const toppingsText = selectedToppings.length > 0
      ? ` + ${selectedToppings.map((t) => t.name).join(", ")}`
      : "";
    toast.success(`เพิ่ม ${product.name}${toppingsText} ลงตะกร้า`);
  };

  const updateQuantity = (productId: number, quantity: number) => {
    dispatchCart({ type: "UPDATE_QTY", productId, quantity });
  };

  const removeFromCart = (productId: number, name: string) => {
    dispatchCart({ type: "REMOVE", productId, name });
  };

  // สแกน QR/Barcode → เพิ่มเข้าบิลทันที (รองรับเครื่องสแกน USB + กล้อง)
  useEffect(() => {
    scanInputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!showToppingDialog && !showPaymentDialog) scanInputRef.current?.focus();
  }, [showToppingDialog, showPaymentDialog]);

  const handleScanSubmit = async () => {
    const code = scanInput.trim();
    if (!code) return;
    setScanInput("");
    try {
      const result = await utils.products.lookupByScan.fetch({ code });
      if (!result) {
        toast.error("ไม่พบสินค้าในระบบ");
        scanInputRef.current?.focus();
        return;
      }
      if (result.type === "product") {
        dispatchCart({ type: "ADD", product: result.product, toppings: [] });
        toast.success(`เพิ่ม ${result.product.name} เข้าบิล`);
      } else {
        dispatchCart({
          type: "ADD",
          product: result.product,
          toppings: [],
          priceOverride: result.totalPrice,
        });
        toast.success(`เพิ่ม ${result.product.name} (จากเครื่องชั่ง) ฿${result.totalPrice.toFixed(2)}`);
      }
      // โฟกัสกลับที่ช่องสแกนทันที — ยิงซ้ำได้ต่อ ไม่ต้องคลิก
      scanInputRef.current?.focus();
    } catch {
      toast.error("ไม่พบสินค้าในระบบ");
      scanInputRef.current?.focus();
    }
  };

  // Calculations
  const subtotal = cart.reduce((sum, item) => sum + item.subtotal, 0);
  const discount = parseFloat(discountAmount) || 0;
  const redeemed = parseFloat(redeemPoints) || 0;
  const activeDiscounts = activeDiscountsQuery.data || [];
  const autoDiscount = useMemo(() => {
    let bestAmount = 0;
    let bestDiscount: any = null;
    for (const discountInfo of activeDiscounts) {
      if (!discountInfo?.autoApply) continue;
      const minBillAmount = discountInfo.minBillAmount
        ? parseFloat(discountInfo.minBillAmount)
        : 0;
      if (minBillAmount > 0 && subtotal < minBillAmount) {
        continue;
      }
      const amount = computeDiscountAmount(discountInfo, subtotal, cart);
      if (amount > bestAmount) {
        bestAmount = amount;
        bestDiscount = discountInfo;
      }
    }
    return { amount: bestAmount, discount: bestDiscount };
  }, [activeDiscounts, cart, subtotal]);
  const subtotalAfterDiscount = Math.max(
    0,
    subtotal - discount - discountFromCode - autoDiscount.amount - redeemed
  );
  const taxRate = taxEnabled ? 0.07 : 0;
  const tax = subtotalAfterDiscount * taxRate;
  const total = subtotalAfterDiscount + tax;

  const handleSelectCustomer = (customer: any) => {
    
    setSelectedCustomer({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      loyaltyPoints: customer.loyaltyPoints || 0,
    });
    setShowCustomerSearch(false);
    setCustomerSearch("");
  };

  const handleApplyDiscountCode = async () => {
    if (!discountCode.trim()) {
      toast.error("กรุณาใส่โค้ดส่วนลด");
      return;
    }

    try {
      const { data: result } = await validateDiscountCodeQuery.refetch();
      if (!result) {
        toast.error("โค้ดส่วนลดไม่ถูกต้องหรือหมดอายุ");
        return;
      }

      const discountInfo = result.discount;

      const minBillAmount = discountInfo.minBillAmount
        ? parseFloat(discountInfo.minBillAmount)
        : 0;
      if (minBillAmount > 0 && subtotal < minBillAmount) {
        toast.error(
          `ต้องมียอดขั้นต่ำ ฿${minBillAmount.toFixed(2)} จึงใช้โค้ดได้`
        );
        return;
      }

      const amount = computeDiscountAmount(discountInfo, subtotal, cart);
      setAppliedDiscount({
        ...discountInfo,
        code: result.code.code,
        codeId: result.code.id,
      });
      setDiscountFromCode(amount);
    toast.success("ใช้โค้ดส่วนลดสำเร็จ");
    } catch (error) {
      toast.error("ใช้โค้ดส่วนลดไม่สำเร็จ");
      console.error(error);
    }
  };

  const handleCheckout = async () => {
    if (cart.length === 0) {
      toast.error("ตะกร้าว่าง");
      return;
    }

    // เปิด payment dialog — ถ้าเงินสด ให้ช่องจำนวนเงินเป็น 0 ให้พนักงานกดเลขเอง
    setTempPaymentAmount(paymentMethod === "cash" ? "0" : total.toFixed(2));
    setShowPaymentDialog(true);
  };

  const confirmPayment = async () => {
    // Validate payment
    if (paymentMethod === "cash") {
      const received = parseFloat(tempPaymentAmount);
      if (isNaN(received) || received < total) {
        toast.error("จำนวนเงินที่ได้รับต้องมากกว่าหรือเท่ากับยอดรวม");
        return;
      }
    }

    try {
      const transactionNumber = `TXN-${Date.now()}`;
      
      await createTransactionMutation.mutateAsync({
        transactionNumber,
        customerId: selectedCustomer?.id,
        subtotal: subtotal.toFixed(2),
        tax: tax.toFixed(2),
        discount: (discount + discountFromCode + autoDiscount.amount).toFixed(2),
        total: total.toFixed(2),
        paymentMethod,
        items: cart.map((item) => ({
          productId: Number(item.productId),
          quantity: item.quantity,
          // API expects string (บาท) เช่น "25.00"
          unitPrice: Number(item.price || 0).toFixed(2),
          discount: "0",
          subtotal: item.subtotal.toFixed(2),
          toppings: item.toppings || [],
        })),
      });

      const receivedAmount = paymentMethod === "cash" ? parseFloat(tempPaymentAmount) : total;
      const changeAmount = paymentMethod === "cash" ? receivedAmount - total : 0;

      setLastTransaction({
        transactionNumber,
        subtotal,
        discount,
        redeemed,
        tax,
        total,
        paymentMethod,
        paymentAmount: receivedAmount,
        change: changeAmount,
        items: cart,
        customer: selectedCustomer,
      });
      
      setShowPaymentDialog(false);
      setShowReceipt(true);
      toast.success("บันทึกการขายสำเร็จ");
      
      // Reset form
      dispatchCart({ type: "CLEAR" });
      setDiscountAmount("0");
      setRedeemPoints("0");
      setDiscountCode("");
      setDiscountFromCode(0);
      setAppliedDiscount(null);
      setTempPaymentAmount("");
      
      // รีเซ็ต selectedCustomer หลังจาก delay เล็กน้อย
      setTimeout(() => setSelectedCustomer(null), 1000);
    } catch (error) {
      const msg =
        (error as any)?.message ||
        (error as any)?.data?.zodError?.message ||
        "เกิดข้อผิดพลาดในการบันทึก";
      toast.error(msg);
      console.error(error);
    }
  };

  // IMPORTANT: อย่า return ออกก่อนเรียก hooks ครบ (กัน React Hook order error)
  const accessStatus = (subscriptionQuery.data as any)?.status as
    | "active"
    | "pending"
    | "expired"
    | "disabled"
    | undefined;

  if (subscriptionQuery.isLoading) {
    return (
      <DashboardLayout>
        <div className="min-h-[60vh] flex items-center justify-center">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            กำลังตรวจสอบสิทธิ์การใช้งาน...
          </div>
        </div>
      </DashboardLayout>
    );
  }

  if (accessStatus && accessStatus !== "active") {
    const msg =
      accessStatus === "expired"
        ? "บัญชีของคุณหมดอายุ กรุณาต่ออายุเพื่อใช้งานต่อ"
        : accessStatus === "pending"
          ? "บัญชีของคุณอยู่ระหว่างรอการอนุมัติ (pending)"
          : "บัญชีของคุณถูกปิดใช้งาน (disabled)";
    return (
      <DashboardLayout>
        <div className="min-h-[70vh] flex items-center justify-center px-4">
          <div className="w-full max-w-lg rounded-xl border bg-card p-6 shadow-sm space-y-4">
            <div className="text-xl font-bold">ไม่สามารถเข้าใช้งาน POS ได้</div>
            <div className="text-muted-foreground">{msg}</div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="outline" onClick={() => setLocation("/")}>
                กลับหน้าแรก
              </Button>
              <Button onClick={() => window.location.reload()}>โหลดใหม่</Button>
            </div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="h-screen flex flex-col bg-white">
        {/* Header Section */}
        <header className="bg-sidebar text-sidebar-foreground px-6 py-4 flex items-center justify-between shadow-md">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-4">
              <img
                src={headerLogoSrc}
                alt={headerStoreName}
                className="h-12 w-12 drop-shadow-lg"
                onError={(e) => {
                  e.currentTarget.src = "/ordera-logo-white.svg";
                }}
              />
              <span className="font-bold text-2xl tracking-tight text-sidebar-foreground drop-shadow-md whitespace-nowrap">
                {headerStoreName}
              </span>
            </div>
          </div>
          
          <div className="flex-1 flex items-center gap-4 max-w-2xl mx-6">
            <div className="flex-1 relative min-w-0">
              <Input
                ref={scanInputRef}
                type="text"
                autoComplete="off"
                placeholder="สแกน QR / บาร์โค้ด (โฟกัสอัตโนมัติ)"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleScanSubmit();
                  }
                }}
                className="h-12 bg-card text-foreground border-2 border-sidebar-accent/50 text-base placeholder:text-muted-foreground"
                data-scan-input
              />
            </div>
            <div className="w-64 shrink-0 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-muted-foreground" />
              <Input
                placeholder="ค้นหาสินค้า..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 h-12 bg-card/80 text-foreground border text-base"
              />
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="text-sidebar-foreground hover:bg-sidebar-accent h-12 w-12">
              <History className="h-6 w-6" />
            </Button>
            <Button variant="ghost" size="icon" className="text-sidebar-foreground hover:bg-sidebar-accent h-12 w-12">
              <DollarSign className="h-6 w-6" />
            </Button>
            <Button variant="ghost" size="icon" className="text-sidebar-foreground hover:bg-sidebar-accent h-12 w-12">
              <User className="h-6 w-6" />
            </Button>
          </div>
        </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Products (ปิด pointer เมื่อเปิด Dialog ท็อปปิ้ง เพื่อไม่ให้กดสินค้าอื่นแล้วเขียนทับ selectedProduct) */}
        <div
          className={`flex-1 flex flex-col bg-white p-6 overflow-hidden ${showToppingDialog ? "pointer-events-none" : ""}`}
        >
          {/* Category & Actions */}
          <div className="flex items-center justify-between mb-6 gap-4">
            <div className="shrink-0">
              <Select
                value={
                  selectedCategory === undefined
                    ? "all"
                    : (() => {
                        const idx = categories.findIndex((c) => c.id === selectedCategory);
                        return idx >= 0 ? `${selectedCategory}-${idx}` : selectedCategory.toString();
                      })()
                }
                onValueChange={(value) => {
                  if (value === "all") {
                    setSelectedCategory(undefined);
                    return;
                  }
                  const idPart = value.includes("-") ? value.split("-")[0] : value;
                  const num = parseInt(idPart, 10);
                  if (!Number.isNaN(num)) setSelectedCategory(num);
                }}
              >
                <SelectTrigger className="w-64 h-12 text-base">
                  <SelectValue placeholder="หมวดหมู่สินค้า" />
                </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-base py-3">รายการโปรด</SelectItem>
                {categories.map((category, index) => (
                  <SelectItem
                    key={`${category.id}-${index}`}
                    value={`${category.id}-${index}`}
                    className="text-base py-3"
                  >
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
              </Select>
            </div>
            
          </div>

          {/* Products Grid */}
          <div className="flex-1 overflow-y-auto">
            {productsQuery.isLoading ? (
              <div className="flex justify-center items-center h-full">
                <Loader2 className="h-12 w-12 animate-spin" />
              </div>
            ) : (
              <div className="grid gap-6 grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {products.map((product) => (
                  <div
                    key={product.id}
                    className="relative cursor-pointer bg-card rounded-lg overflow-hidden shadow-sm hover:shadow-md hover:ring-2 hover:ring-product/30 transition-shadow min-h-[180px] touch-manipulation active:scale-[0.98]"
                    onClick={() => addToCart(product)}
                  >
                    {product.imageUrl ? (
                      <div className="relative">
                        <img
                          src={product.imageUrl}
                          alt={product.name}
                          className="w-full h-40 object-cover"
                          onError={(e) => {
                            console.error("[Sales] Image load error:", product.imageUrl);
                            e.currentTarget.style.display = "none";
                            e.currentTarget.parentElement!.innerHTML = '<div class="w-full h-40 bg-gray-200 flex items-center justify-center relative"><div class="absolute top-3 right-3 bg-product text-white px-3 py-2 rounded text-sm font-bold">฿' + parseFloat(product.price).toFixed(2) + '</div></div>';
                          }}
                          onLoad={() => {
                          }}
                        />
                        <div className="absolute top-3 right-3 bg-product text-white px-3 py-2 rounded text-sm font-bold">
                          ฿{parseFloat(product.price).toFixed(2)}
                        </div>
                      </div>
                    ) : (
                      <div className="w-full h-40 bg-gray-200 flex items-center justify-center relative">
                        <div className="absolute top-3 right-3 bg-product text-white px-3 py-2 rounded text-sm font-bold">
                          ฿{parseFloat(product.price).toFixed(2)}
                        </div>
                      </div>
                    )}
                    <div className="p-4">
                      <h3 className="font-medium text-base text-center truncate">
                        {product.name}
                      </h3>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Panel - Cart (POS Bottom Bar กด "ตะกร้า" จะ scroll มาที่นี่) */}
        <div data-pos-cart-panel className="w-[420px] min-w-[320px] shrink-0 bg-white border-l flex flex-col" lang="th">
          {/* Cart Header */}
          <div className="p-6 border-b flex items-center justify-between gap-3">
            <Button
              variant="outline"
              onClick={() => setShowCustomerSearch(true)}
              className="flex-1 min-w-0 h-12 text-base"
            >
              <User className="h-5 w-5 mr-2 shrink-0" />
              <span className="min-w-0 truncate">เลือกสมาชิก</span>
            </Button>
            <Button variant="outline" className="h-12 px-6 text-base shrink-0 whitespace-nowrap">
              ราคาปลีก
            </Button>
          </div>

          {/* Cart Items */}
          <div className="flex-1 overflow-y-auto p-6 space-y-3">
            {cart.length === 0 ? (
              <p className="text-base text-muted-foreground text-center py-12">
                ตะกร้าว่าง
              </p>
            ) : (
              cart.map((item, index) => (
                <div
                  key={`${item.productId}-${index}-${JSON.stringify(item.toppings || [])}`}
                  className="flex items-center justify-between gap-3 p-4 border rounded-lg"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-base font-medium truncate">
                      {item.name}
                    </p>
                    {item.toppings && item.toppings.length > 0 && (
                      <p className="text-sm text-muted-foreground mt-1">
                        + {item.toppings.map(t => t.name).join(", ")}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-base text-muted-foreground">
                      × {item.quantity}
                    </span>
                    <span className="text-base font-medium w-20 text-right">
                      ฿{item.subtotal.toFixed(2)}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeFromCart(item.productId, item.name)}
                      className="min-w-[var(--touch-target)] min-h-[var(--touch-target)]"
                    >
                      <X className="h-5 w-5 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* โค้ดส่วนลด */}
          <div className="px-6 py-3 border-t">
            <div className="flex gap-2">
              <Input
                placeholder="ใส่โค้ดส่วนลด"
                value={discountCode}
                onChange={(e) => setDiscountCode(e.target.value.toUpperCase())}
                disabled={!!appliedDiscount}
                className="flex-1"
              />
              {appliedDiscount ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setAppliedDiscount(null);
                    setDiscountFromCode(0);
                    setDiscountCode("");
                  }}
                >
                  ลบโค้ด
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleApplyDiscountCode}
                  disabled={cart.length === 0 || !discountCode.trim()}
                >
                  ใช้โค้ด
                </Button>
              )}
            </div>
            {appliedDiscount && (
              <p className="text-sm text-green-600 mt-1">
                ใช้โค้ด {appliedDiscount.code} แล้ว -฿{discountFromCode.toFixed(2)}
              </p>
            )}
          </div>

          {/* Summary */}
          <div className="p-6 border-t space-y-3 bg-gray-50">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground whitespace-nowrap">
                คำนวณภาษี (7%)
              </div>
              <Button
                type="button"
                variant={taxEnabled ? "default" : "outline"}
                size="sm"
                onClick={() => setTaxEnabled((v) => !v)}
              >
                {taxEnabled ? "เปิด" : "ปิด"}
              </Button>
            </div>
            <div className="flex justify-between text-base">
              <span className="whitespace-nowrap">รวม</span>
              <span className="font-medium">฿{subtotal.toFixed(2)}</span>
            </div>
            {(discountFromCode + discount + autoDiscount.amount + redeemed) > 0 && (
              <div className="flex justify-between text-base text-green-600">
                <span className="whitespace-nowrap">ส่วนลด</span>
                <span className="font-medium">-฿{(discountFromCode + discount + autoDiscount.amount + redeemed).toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between text-base">
              <span className="whitespace-nowrap">ภาษี</span>
              <span className="font-medium">฿{tax.toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-bold text-xl border-t pt-3">
              <span className="whitespace-nowrap">รวมทั้งหมด</span>
              <span>฿{total.toFixed(2)}</span>
            </div>
          </div>

          {/* Pay Button */}
          <div className="p-6 border-t">
            <Button
              variant="pay"
              onClick={handleCheckout}
              disabled={cart.length === 0 || createTransactionMutation.isPending}
              className="w-full text-xl py-8 h-auto min-h-[64px] font-bold whitespace-nowrap"
            >
              {createTransactionMutation.isPending ? (
                <>
                  <Loader2 className="mr-3 h-6 w-6 animate-spin shrink-0" />
                  กำลังบันทึก...
                </>
              ) : (
                "ชำระเงิน"
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Customer Search Dialog */}
      <Dialog open={showCustomerSearch} onOpenChange={(open) => {
        setShowCustomerSearch(open);
        if (!open) {
          // รีเซ็ต search เมื่อปิด dialog
          setCustomerSearch("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ค้นหาลูกค้า</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <Input
              placeholder="ค้นหาตามชื่อหรือเบอร์โทร..."
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              autoFocus
            />
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {customersQuery.isLoading ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              ) : customers.length === 0 ? (
                <p className="text-center text-muted-foreground py-4">
                  {customerSearch ? `ไม่พบลูกค้าที่ค้นหา "${customerSearch}"` : "ไม่มีข้อมูลลูกค้า"}
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground px-2">
                    พบ {customers.length} รายการ
                  </p>
                  {customers.map((customer) => (
                    <Button
                      key={customer.id}
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => handleSelectCustomer(customer)}
                    >
                      <div className="text-left">
                        <p className="font-medium">{customer.name}</p>
                        <p className="text-xs text-muted-foreground">
                          ID: {customer.id} • {customer.phone} • คะแนน: {customer.loyaltyPoints || 0}
                        </p>
                      </div>
                    </Button>
                  ))}
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Payment Method Dialog */}
      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>เลือกวิธีการชำระเงิน</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Payment Method Selection */}
            <div className="space-y-2">
              <label className="text-sm font-medium">วิธีชำระเงิน</label>
              <div className="grid grid-cols-3 gap-4">
                <Button
                  type="button"
                  variant={paymentMethod === "cash" ? "default" : "outline"}
                  onClick={() => {
                    setPaymentMethod("cash");
                    setTempPaymentAmount("0");
                  }}
                  className="h-20 flex flex-col gap-2 text-base"
                >
                  <DollarSign className="h-6 w-6" />
                  <span className="font-medium">เงินสด</span>
                </Button>
                <Button
                  type="button"
                  variant={paymentMethod === "transfer" ? "default" : "outline"}
                  onClick={() => {
                    setPaymentMethod("transfer");
                    setTempPaymentAmount(total.toFixed(2));
                  }}
                  className="h-20 flex flex-col gap-2 text-base"
                >
                  <DollarSign className="h-6 w-6" />
                  <span className="font-medium">โอนเงิน</span>
                </Button>
                <Button
                  type="button"
                  variant={paymentMethod === "card" ? "default" : "outline"}
                  onClick={() => {
                    setPaymentMethod("card");
                    setTempPaymentAmount(total.toFixed(2));
                  }}
                  className="h-20 flex flex-col gap-2 text-base"
                >
                  <DollarSign className="h-6 w-6" />
                  <span className="font-medium">บัตร</span>
                </Button>
              </div>
            </div>

            {/* Cash Payment Input */}
            {paymentMethod === "cash" && (
              <div className="space-y-3">
                <label className="text-base font-medium">จำนวนเงินที่ได้รับ</label>
                <Input
                  type="number"
                  value={tempPaymentAmount}
                  onChange={(e) => setTempPaymentAmount(e.target.value)}
                  placeholder="0.00"
                  autoFocus
                  className="h-14 text-lg"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      confirmPayment();
                    }
                  }}
                />
                {parseFloat(tempPaymentAmount || "0") >= total && (
                  <div className="text-base text-muted-foreground">
                    เงินทอน: ฿{(parseFloat(tempPaymentAmount || "0") - total).toFixed(2)}
                  </div>
                )}
                {parseFloat(tempPaymentAmount || "0") < total && parseFloat(tempPaymentAmount || "0") > 0 && (
                  <div className="text-base text-destructive">
                    จำนวนเงินไม่พอ (ขาด: ฿{(total - parseFloat(tempPaymentAmount || "0")).toFixed(2)})
                  </div>
                )}
              </div>
            )}

            {/* Summary */}
            <div className="border-t pt-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span>ยอดรวม:</span>
                <span className="font-bold text-lg">฿{total.toFixed(2)}</span>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-4">
              <Button
                variant="outline"
                onClick={() => setShowPaymentDialog(false)}
                className="flex-1 h-14 text-base"
              >
                ยกเลิก
              </Button>
              <Button
                variant="pay"
                onClick={confirmPayment}
                disabled={createTransactionMutation.isPending || (paymentMethod === "cash" && (parseFloat(tempPaymentAmount || "0") < total))}
                className="flex-1 h-14 text-base font-medium"
              >
                {createTransactionMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    กำลังบันทึก...
                  </>
                ) : (
                  "ยืนยันการชำระเงิน"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Toppings Selection Dialog */}
      <Dialog
        open={showToppingDialog}
        onOpenChange={(open) => {
          setShowToppingDialog(open);
          if (!open) {
            setSelectedProductForTopping(null);
            setSelectedToppings([]);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl">
              {selectedProductForTopping?.name}
            </DialogTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {toppingsQuery.isLoading && !toppingsQuery.data
                ? "กำลังโหลด..."
                : ((toppingsQuery.data || []).length > 0)
                  ? "กดท็อปปิ้งที่ต้องการ (กดอีกรอบเพื่อยกเลิก) ไม่ต้องการก็ข้ามได้"
                  : "กดเพิ่มลงตะกร้าได้เลย"}
            </p>
          </DialogHeader>
          <div className="space-y-4">
            {(toppingsQuery.isLoading && !toppingsQuery.data) || (toppingsQuery.data || []).length > 0 ? (
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {toppingsQuery.isLoading ? (
                  <div className="flex justify-center py-6">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  (toppingsQuery.data || []).map((topping) => {
                    const isSelected = selectedToppings.some(
                      t => t.id === topping.id && t.name === topping.name
                    );
                    return (
                      <button
                        key={`${topping.id}-${topping.name}`}
                        type="button"
                        onClick={() => {
                          if (isSelected) {
                            setSelectedToppings(selectedToppings.filter(
                              t => !(t.id === topping.id && t.name === topping.name)
                            ));
                          } else {
                            setSelectedToppings([...selectedToppings, {
                              id: topping.id,
                              name: topping.name,
                              price: topping.price,
                            }]);
                          }
                        }}
                        className={`w-full flex items-center justify-between gap-3 rounded-xl border-2 px-4 py-4 text-left transition-all touch-manipulation
                          ${isSelected
                            ? "border-add bg-add/10 text-add shadow-sm"
                            : "border-gray-200 bg-white hover:border-product hover:bg-gray-50"}`}
                      >
                        <span className="font-medium text-base">{topping.name}</span>
                        <span className="flex items-center gap-2">
                          <span className="font-medium text-base">+฿{topping.price.toFixed(2)}</span>
                          {isSelected && <Check className="h-5 w-5 text-add shrink-0" />}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            ) : null}

            {/* สรุปราคา — แสดงเสมอ */}
            <div className="rounded-xl bg-gray-50 border p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{selectedProductForTopping?.name}</span>
                <span>฿{parseFloat(selectedProductForTopping?.price || "0").toFixed(2)}</span>
              </div>
              {selectedToppings.length > 0 && (
                <>
                  {selectedToppings.map((t) => (
                    <div key={`${t.id}-${t.name}`} className="flex justify-between text-sm">
                      <span className="text-muted-foreground">+ {t.name}</span>
                      <span>+฿{t.price.toFixed(2)}</span>
                    </div>
                  ))}
                </>
              )}
              <div className="flex justify-between font-bold text-base pt-2 border-t border-gray-200">
                <span>รวม</span>
                <span className="text-black font-bold">
                  ฿{(
                    parseFloat(selectedProductForTopping?.price || "0") +
                    selectedToppings.reduce((sum, t) => sum + t.price, 0)
                  ).toFixed(2)}
                </span>
              </div>
            </div>

            {/* ปุ่มใหญ่มุมล่าง — กดง่าย */}
            <div className="flex gap-3 pt-1">
              <Button
                variant="outline"
                onClick={() => {
                  setShowToppingDialog(false);
                  setSelectedProductForTopping(null);
                  setSelectedToppings([]);
                }}
                className="flex-1 h-14 text-base rounded-xl"
              >
                ยกเลิก
              </Button>
              <Button
                variant="add"
                onClick={handleConfirmToppings}
                className="flex-1 h-14 text-base font-semibold rounded-xl"
              >
                เพิ่มลงตะกร้า
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Receipt Modal */}
      <Dialog open={showReceipt} onOpenChange={setShowReceipt}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>ใบเสร็จการขาย</DialogTitle>
          </DialogHeader>
          {lastTransaction && (
            <div className="space-y-4">
              {/* Receipt Content */}
              <div className="border-2 border-dashed p-4 rounded space-y-2 text-sm">
                {/* Header Text from Template */}
                {receiptTemplateQuery.data?.headerText && (
                  <div className="text-center border-b pb-2 whitespace-pre-line">
                    {receiptTemplateQuery.data.headerText.split('\n').map((line: string, idx: number) => (
                      <p key={idx} className="text-xs">{line}</p>
                    ))}
                  </div>
                )}
                
                {/* Company Name (if enabled) */}
                {receiptTemplateQuery.data?.showCompanyName !== false && (
                  <div className="text-center border-b pb-2">
                    <p className="font-bold text-lg">ใบเสร็จการขาย</p>
                  </div>
                )}
                
                {/* Transaction Number (if enabled) */}
                {receiptTemplateQuery.data?.showTransactionId !== false && (
                  <div className="text-center border-b pb-2">
                    <p className="text-xs text-muted-foreground">เลขที่: {lastTransaction.transactionNumber}</p>
                  </div>
                )}
                
                {/* Date and Time (if enabled) */}
                {(receiptTemplateQuery.data?.showDate || receiptTemplateQuery.data?.showTime) && (
                  <div className="text-center border-b pb-2 text-xs">
                    {receiptTemplateQuery.data?.showDate && (
                      <p>วันที่: {new Date().toLocaleDateString('th-TH')}</p>
                    )}
                    {receiptTemplateQuery.data?.showTime && (
                      <p>เวลา: {new Date().toLocaleTimeString('th-TH')}</p>
                    )}
                  </div>
                )}

                {lastTransaction.customer && (
                  <div className="text-center border-b pb-2 text-xs">
                    <p>ลูกค้า: {lastTransaction.customer.name}</p>
                  </div>
                )}

                {/* Items */}
                <div className="space-y-1 border-b pb-2">
                  {lastTransaction.items.map((item: CartItem, index: number) => (
                    <div key={`${item.productId}-${index}`} className="space-y-0.5">
                      <div className="flex justify-between text-xs">
                        <span>{item.name} × {item.quantity}</span>
                        <span>฿{item.subtotal.toFixed(2)}</span>
                      </div>
                      {item.toppings && item.toppings.length > 0 && (
                        <div className="pl-2 space-y-0.5">
                          {item.toppings.map((topping) => (
                            <div key={topping.id} className="flex justify-between text-xs text-muted-foreground">
                              <span> + {topping.name}</span>
                              <span>฿{(topping.price * item.quantity).toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Summary */}
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span>รวม:</span>
                    <span>฿{(lastTransaction.subtotal || 0).toFixed(2)}</span>
                  </div>
                  {(lastTransaction.discount || 0) > 0 && (
                    <div className="flex justify-between text-accent">
                      <span>ส่วนลด:</span>
                      <span>-฿{(lastTransaction.discount || 0).toFixed(2)}</span>
                    </div>
                  )}
                  {(lastTransaction.redeemed || 0) > 0 && (
                    <div className="flex justify-between text-accent">
                      <span>แลกคะแนน:</span>
                      <span>-฿{(lastTransaction.redeemed || 0).toFixed(2)}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span>ภาษี (7%):</span>
                    <span>฿{(lastTransaction.tax || 0).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between font-bold border-t pt-1">
                    <span>รวมทั้งสิ้น:</span>
                    <span>฿{(lastTransaction.total || 0).toFixed(2)}</span>
                  </div>
                </div>

                {/* Payment Info */}
                <div className="space-y-1 text-xs border-t pt-2">
                  <div className="flex justify-between">
                    <span>วิธีชำระ:</span>
                    <span>
                      {lastTransaction.paymentMethod === 'cash' ? 'เงินสด' : lastTransaction.paymentMethod === 'transfer' ? 'โอนเงิน' : 'บัตร'}
                    </span>
                  </div>
                  {lastTransaction.paymentMethod === 'cash' && lastTransaction.paymentAmount && (
                    <>
                      <div className="flex justify-between">
                        <span>จำนวนเงินที่ได้รับ:</span>
                        <span>฿{(lastTransaction.paymentAmount || 0).toFixed(2)}</span>
                      </div>
                      {lastTransaction.change !== undefined && (
                        <div className="flex justify-between font-semibold text-accent">
                          <span>เงินทอน:</span>
                          <span>฿{(lastTransaction.change || 0).toFixed(2)}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Footer Text from Template */}
                {receiptTemplateQuery.data?.footerText && (
                  <div className="text-center border-t pt-2 whitespace-pre-line">
                    {receiptTemplateQuery.data.footerText.split('\n').map((line: string, idx: number) => (
                      <p key={idx} className="text-xs text-muted-foreground">{line}</p>
                    ))}
                  </div>
                )}
                
                {/* Default footer if no template footer */}
                {!receiptTemplateQuery.data?.footerText && (
                  <div className="text-center text-xs text-muted-foreground border-t pt-2">
                    <p>ขอบคุณที่ใช้บริการ</p>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex gap-2">
                <Button
                  onClick={() => window.print()}
                  className="flex-1"
                  variant="outline"
                >
                  <Printer className="mr-2 h-4 w-4" />
                  พิมพ์
                </Button>
                <Button
                  onClick={() => setShowReceipt(false)}
                  className="flex-1"
                >
                  ปิด
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      </div>
    </DashboardLayout>
  );
}
