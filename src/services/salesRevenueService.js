/**
 * Item-level revenue: only delivered line items count toward gross revenue.
 * Returns/refunds reduce net revenue (order.refundAmount or returned item value).
 */

export function money(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function getItemAmount(item) {
  if (!item) return 0;
  if (item.finalAmount != null) return money(item.finalAmount);
  if (item.finalPrice != null) return money(item.finalPrice);
  if (item.paidAmount != null) return money(item.paidAmount);
  if (item.lineTotal != null) return money(item.lineTotal);
  return money((item.unitPrice || 0) * (item.quantity || 0));
}

export function getItemDiscount(item) {
  return money(item?.discountShare) + money(item?.couponDiscount);
}

const RETURNED_ITEM_STATUSES = new Set(["returned", "return_requested"]);
const CANCELLED_ITEM_STATUSES = new Set(["cancelled"]);

/** Fulfillment in progress — not completed until these clear */
export const PIPELINE_ITEM_STATUSES = new Set([
  "pending",
  "confirmed",
  "shipped",
  "out_for_delivery",
]);

export const RETURN_ITEM_STATUSES = new Set([
  "returned",
  "return_requested",
  "return_rejected",
]);

export function computeOrderMetrics(order) {
  let grossRevenue = 0;
  let itemDiscount = 0;
  let deliveredQty = 0;
  let returnedItemValue = 0;
  let cancelledItemValue = 0;
  let hasDeliveredItem = false;

  for (const item of order.items || []) {
    const amt = getItemAmount(item);
    const disc = getItemDiscount(item);

    if (item.status === "delivered") {
      grossRevenue += amt;
      itemDiscount += disc;
      deliveredQty += item.quantity || 0;
      hasDeliveredItem = true;
    } else if (RETURNED_ITEM_STATUSES.has(item.status)) {
      returnedItemValue += amt;
    } else if (CANCELLED_ITEM_STATUSES.has(item.status)) {
      cancelledItemValue += amt;
    }
  }

  const orderRefund = money(order.refundAmount);
  const refundAmount = orderRefund > 0 ? orderRefund : returnedItemValue;
  const netRevenue = Math.max(0, grossRevenue - Math.min(refundAmount, grossRevenue + returnedItemValue));

  const orderLevelDiscount = money(order.discount) + money(order.couponDiscount);

  return {
    grossRevenue,
    itemDiscount,
    orderLevelDiscount,
    totalDiscount: itemDiscount + orderLevelDiscount,
    refundAmount,
    netRevenue,
    deliveredQty,
    returnedItemValue,
    cancelledItemValue,
    hasDeliveredItem,
    originalAmount: money(order.subtotal) || grossRevenue + cancelledItemValue + returnedItemValue,
  };
}

export function resolveDateRange(query = {}) {
  const { startDate, endDate, filterType, year, month, weekDate, dailyDate } = query;
  const now = new Date();
  
  let from;
  let to = new Date(now);
  to.setHours(23, 59, 59, 999);
  
  let finalFilterType = filterType || "monthly_last30"; // default to last 30 days
  let label = "";
  
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-indexed

  if (finalFilterType === "yearly") {
    const filterYear = parseInt(year) || currentYear;
    from = new Date(filterYear, 0, 1, 0, 0, 0, 0);
    to = new Date(filterYear, 11, 31, 23, 59, 59, 999);
    label = `Year: ${filterYear}`;
  } 
  else if (finalFilterType === "monthly") {
    const filterYear = parseInt(year) || currentYear;
    const filterMonth = parseInt(month) || currentMonth;
    from = new Date(filterYear, filterMonth - 1, 1, 0, 0, 0, 0);
    to = new Date(filterYear, filterMonth, 0, 23, 59, 59, 999); // last day of that month
    const monthName = from.toLocaleString('en-US', { month: 'long' });
    label = `${monthName} ${filterYear}`;
  } 
  else if (finalFilterType === "weekly") {
    let refDate = weekDate ? new Date(weekDate) : new Date(now);
    if (isNaN(refDate.getTime())) {
      refDate = new Date(now);
    }
    const day = refDate.getDay();
    const diff = refDate.getDate() - day + (day === 0 ? -6 : 1); // Monday
    from = new Date(refDate.setDate(diff));
    from.setHours(0, 0, 0, 0);
    
    to = new Date(from);
    to.setDate(from.getDate() + 6);
    to.setHours(23, 59, 59, 999);
    label = `Week: ${from.toLocaleDateString('en-GB')} – ${to.toLocaleDateString('en-GB')}`;
  } 
  else if (finalFilterType === "daily") {
    let refDate = dailyDate ? new Date(dailyDate) : new Date(now);
    if (isNaN(refDate.getTime())) {
      refDate = new Date(now);
    }
    from = new Date(refDate);
    from.setHours(0, 0, 0, 0);
    to = new Date(refDate);
    to.setHours(23, 59, 59, 999);
    label = `Day: ${from.toLocaleDateString('en-GB')}`;
  } 
  else if (finalFilterType === "custom") {
    if (startDate && endDate) {
      from = new Date(startDate);
      from.setHours(0, 0, 0, 0);
      to = new Date(endDate);
      to.setHours(23, 59, 59, 999);
      label = `Custom Range: ${from.toLocaleDateString('en-GB')} – ${to.toLocaleDateString('en-GB')}`;
    } else {
      from = new Date(now);
      from.setDate(from.getDate() - 29);
      from.setHours(0, 0, 0, 0);
      label = `Last 30 Days (Custom Select)`;
    }
  } 
  else if (finalFilterType === "weekly_last7" || finalFilterType === "weekly") {
    finalFilterType = "weekly_last7";
    from = new Date(now);
    from.setDate(from.getDate() - 6);
    from.setHours(0, 0, 0, 0);
    label = "Last 7 Days";
  } 
  else { // monthly_last30, monthly, or default
    finalFilterType = "monthly_last30";
    from = new Date(now);
    from.setDate(from.getDate() - 29);
    from.setHours(0, 0, 0, 0);
    label = "Last 30 Days";
  }

  return {
    from,
    to,
    filterType: finalFilterType,
    label,
    mongoMatch: { createdAt: { $gte: from, $lte: to } },
  };
}

export function getOrderListMatch(query = {}) {
  const range = resolveDateRange(query);
  const match = {
    ...range.mongoMatch,
    orderStatus: { $nin: ["expired"] },
  };

  if (query.orderStatus && query.orderStatus !== "all") {
    match.orderStatus = query.orderStatus;
  }

  return match;
}

function formatDateIN(d) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatDateTimeIN(d) {
  return new Date(d).toLocaleString("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatProductsSummary(items, statusFilter = null) {
  const list = (items || []).filter((i) => !statusFilter || i.status === statusFilter);
  if (!list.length) return "—";
  return list
    .map((i) => `${i.productName} (×${i.quantity})`)
    .join("; ");
}

/**
 * Dashboard / KPI bucket from line items:
 * - delivered: ≥1 delivered item, not all cancelled, nothing still in pipeline
 * - cancelled: every item cancelled
 * - pending: any item pending / confirmed / shipped / out_for_delivery
 * - returned: no pipeline, no delivered, but has return statuses
 */
export function classifyOrderBucket(order) {
  const items = order.items || [];
  if (!items.length) {
    const s = order.orderStatus;
    if (s === "delivered") return "delivered";
    if (s === "cancelled" || s === "expired") return "cancelled";
    if (RETURN_ITEM_STATUSES.has(s) || s === "returned") return "returned";
    if (PIPELINE_ITEM_STATUSES.has(s) || s === "partially_cancelled") return "pending";
    return "pending";
  }

  const statuses = items.map((i) => i.status || "pending");

  if (statuses.every((s) => s === "cancelled")) return "cancelled";

  if (statuses.some((s) => PIPELINE_ITEM_STATUSES.has(s))) return "pending";

  if (statuses.some((s) => s === "delivered")) return "delivered";

  if (statuses.some((s) => RETURN_ITEM_STATUSES.has(s))) return "returned";

  return "pending";
}

/** Derive stored orderStatus from item statuses (admin updates). */
export function deriveOrderStatusFromItems(items = []) {
  if (!items.length) return "pending";

  const statuses = items.map((i) => i.status || "pending");

  if (statuses.every((s) => s === statuses[0])) return statuses[0];

  if (statuses.every((s) => s === "cancelled")) return "cancelled";
  if (statuses.every((s) => s === "delivered")) return "delivered";

  if (statuses.some((s) => PIPELINE_ITEM_STATUSES.has(s))) {
    const priority = ["out_for_delivery", "shipped", "confirmed", "pending"];
    const active = statuses.filter(
      (s) => !["cancelled", "returned", "return_requested", "return_rejected"].includes(s),
    );
    return priority.find((p) => active.includes(p)) || active[0] || "pending";
  }

  if (statuses.some((s) => s === "delivered")) return "delivered";

  const allTerminal = statuses.every((s) =>
    ["returned", "return_requested", "cancelled"].includes(s),
  );
  if (allTerminal) return "returned";

  if (statuses.some((s) => s === "cancelled")) return "partially_cancelled";

  if (statuses.some((s) => RETURN_ITEM_STATUSES.has(s))) return "returned";

  return "pending";
}

export function buildDashboardGroupedCounts(orders = []) {
  const counts = { completed: 0, pending: 0, closed: 0, reverse: 0 };
  for (const order of orders) {
    const bucket = classifyOrderBucket(order);
    if (bucket === "delivered") counts.completed += 1;
    else if (bucket === "cancelled") counts.closed += 1;
    else if (bucket === "returned") counts.reverse += 1;
    else counts.pending += 1;
  }
  return counts;
}

export function buildOrderReportRow(order) {
  const m = computeOrderMetrics(order);
  const customer = order.userId
    ? `${order.userId.firstName || ""} ${order.userId.lastName || ""}`.trim()
    : "Guest";

  const deliveredItems = (order.items || []).filter((i) => i.status === "delivered");
  const deliveredQty = deliveredItems.reduce((s, i) => s + (i.quantity || 0), 0);
  const totalQty = (order.items || []).reduce((s, i) => s + (i.quantity || 0), 0);

  return {
    orderId: order.orderId,
    customer,
    date: formatDateIN(order.createdAt),
    orderDate: order.createdAt,
    status: order.orderStatus,
    statusLabel: (order.orderStatus || "").replace(/_/g, " "),
    paymentMethod: (order.paymentMethod || "—").toUpperCase(),
    paymentStatus: (order.paymentStatus || "—").replace(/_/g, " "),
    products: formatProductsSummary(order.items),
    productsDelivered: formatProductsSummary(order.items, "delivered"),
    quantity: totalQty,
    deliveredQuantity: deliveredQty,
    originalAmount: m.originalAmount,
    discount: m.totalDiscount,
    refund: m.refundAmount,
    grossRevenue: m.grossRevenue,
    finalRevenue: m.netRevenue,
    metrics: m,
  };
}

export function buildSalesReportPayload(orders, options = {}) {
  const range = options.dateRange || resolveDateRange(options.query || {});
  const generatedBy = options.generatedBy || "Admin";

  const summary = {
    totalOrders: orders.length,
    deliveredOrders: 0,
    cancelledOrders: 0,
    returnedOrders: 0,
    pendingOrders: 0,
    grossRevenue: 0,
    totalDiscounts: 0,
    refundAmount: 0,
    netRevenue: 0,
  };

  const orderRows = [];
  const productMap = new Map();
  const categoryMap = new Map();
  const trendMap = new Map();
  const paymentAnalytics = {
    cod: { orders: 0, revenue: 0 },
    razorpay: { orders: 0, revenue: 0 },
    wallet: { orders: 0, revenue: 0 },
    other: { orders: 0, revenue: 0 },
    failed: { orders: 0 },
    refunded: { orders: 0, amount: 0 },
  };

  for (const order of orders) {
    const row = buildOrderReportRow(order);
    const m = row.metrics;
    orderRows.push(row);

    const bucket = classifyOrderBucket(order);
    if (bucket === "delivered") summary.deliveredOrders += 1;
    else if (bucket === "cancelled") summary.cancelledOrders += 1;
    else if (bucket === "returned") summary.returnedOrders += 1;
    else summary.pendingOrders += 1;

    summary.grossRevenue += m.grossRevenue;
    summary.totalDiscounts += m.totalDiscount;
    summary.refundAmount += m.refundAmount;
    summary.netRevenue += m.netRevenue;

    const dayKey = new Date(order.createdAt).toISOString().split("T")[0];
    trendMap.set(dayKey, (trendMap.get(dayKey) || 0) + m.netRevenue);

    const pm = (order.paymentMethod || "other").toLowerCase();
    if (order.paymentStatus === "failed") {
      paymentAnalytics.failed.orders += 1;
    }
    if (money(order.refundAmount) > 0 || order.paymentStatus === "refunded" || order.paymentStatus === "partially_refunded") {
      paymentAnalytics.refunded.orders += 1;
      paymentAnalytics.refunded.amount += m.refundAmount;
    }

    if (pm === "cod") {
      paymentAnalytics.cod.orders += 1;
      paymentAnalytics.cod.revenue += m.netRevenue;
    } else if (pm === "razorpay") {
      paymentAnalytics.razorpay.orders += 1;
      paymentAnalytics.razorpay.revenue += m.netRevenue;
    } else if (pm === "wallet") {
      paymentAnalytics.wallet.orders += 1;
      paymentAnalytics.wallet.revenue += m.netRevenue;
    } else {
      paymentAnalytics.other.orders += 1;
      paymentAnalytics.other.revenue += m.netRevenue;
    }

    for (const item of order.items || []) {
      if (item.status !== "delivered") continue;
      const pid = String(item.productId || item.productName);
      const prev = productMap.get(pid) || {
        name: item.productName,
        units: 0,
        revenue: 0,
      };
      prev.units += item.quantity || 0;
      prev.revenue += getItemAmount(item);
      productMap.set(pid, prev);

      const catName = item.categoryName || order._categoryName;
      if (catName) {
        const cprev = categoryMap.get(catName) || { name: catName, units: 0, revenue: 0 };
        cprev.units += item.quantity || 0;
        cprev.revenue += getItemAmount(item);
        categoryMap.set(catName, cprev);
      }
    }
  }

  const revenueTrend = [...trendMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, revenue]) => ({ date, revenue }));

  const topProducts = [...productMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 15);
  const topCategories = [...categoryMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 15);

  return {
    meta: {
      companyName: "ElectroHub",
      title: "Sales & Revenue Report",
      from: formatDateIN(range.from),
      to: formatDateIN(range.to),
      generatedAt: formatDateTimeIN(new Date()),
      generatedBy,
      periodLabel: range.label,
    },
    summary,
    orderRows,
    topProducts,
    topCategories,
    revenueTrend,
    paymentAnalytics,
    dateRange: range,
  };
}

export function buildChartSeriesFromOrders(orders, filterType = "monthly_last30", query = {}) {
  const range = resolveDateRange({ filterType, ...query });
  const start = range.from;
  const end = range.to;

  const trendMap = new Map();

  if (range.filterType === "yearly") {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    
    // Initialize map with all 12 months
    for (let i = 0; i < 12; i++) {
      trendMap.set(i, { label: monthNames[i], revenue: 0 });
    }
    
    for (const order of orders) {
      const m = computeOrderMetrics(order);
      const orderDate = new Date(order.createdAt);
      const monthIdx = orderDate.getMonth();
      if (trendMap.has(monthIdx)) {
        trendMap.get(monthIdx).revenue += m.netRevenue;
      }
    }
    
    return [...trendMap.values()].map(item => ({
      _id: item.label,
      revenue: item.revenue
    }));
  } 
  else if (range.filterType === "daily") {
    // Hourly grouping
    for (let h = 0; h < 24; h++) {
      const hourLabel = h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
      trendMap.set(h, { label: hourLabel, revenue: 0 });
    }
    
    for (const order of orders) {
      const m = computeOrderMetrics(order);
      const orderDate = new Date(order.createdAt);
      const hr = orderDate.getHours();
      if (trendMap.has(hr)) {
        trendMap.get(hr).revenue += m.netRevenue;
      }
    }
    
    return [...trendMap.values()].map(item => ({
      _id: item.label,
      revenue: item.revenue
    }));
  } 
  else {
    // Group by day for custom, monthly, weekly, weekly_last7, monthly_last30
    const temp = new Date(start);
    const totalDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
    
    if (totalDays > 366) {
      // Group by year if span is more than a year
      for (const order of orders) {
        const m = computeOrderMetrics(order);
        const y = new Date(order.createdAt).getFullYear();
        trendMap.set(y, (trendMap.get(y) || 0) + m.netRevenue);
      }
      return [...trendMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([y, revenue]) => ({ _id: String(y), revenue }));
    }
    else if (totalDays > 31) {
      // Group by month if span is more than a month (but <= a year)
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      let curr = new Date(start);
      while (curr <= end) {
        const key = `${monthNames[curr.getMonth()]} ${curr.getFullYear()}`;
        if (!trendMap.has(key)) {
          trendMap.set(key, 0);
        }
        curr.setMonth(curr.getMonth() + 1);
      }
      const endKey = `${monthNames[end.getMonth()]} ${end.getFullYear()}`;
      if (!trendMap.has(endKey)) {
        trendMap.set(endKey, 0);
      }

      for (const order of orders) {
        const m = computeOrderMetrics(order);
        const orderDate = new Date(order.createdAt);
        const key = `${monthNames[orderDate.getMonth()]} ${orderDate.getFullYear()}`;
        if (trendMap.has(key)) {
          trendMap.set(key, trendMap.get(key) + m.netRevenue);
        }
      }

      return [...trendMap.entries()].map(([label, revenue]) => ({
        _id: label,
        revenue
      }));
    }
    else {
      // Group by day
      while (temp <= end) {
        const key = temp.toISOString().split("T")[0];
        const label = temp.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
        trendMap.set(key, { label, revenue: 0 });
        temp.setDate(temp.getDate() + 1);
      }

      for (const order of orders) {
        const m = computeOrderMetrics(order);
        const key = new Date(order.createdAt).toISOString().split("T")[0];
        if (trendMap.has(key)) {
          trendMap.get(key).revenue += m.netRevenue;
        }
      }

      return [...trendMap.values()].map(item => ({
        _id: item.label,
        revenue: item.revenue
      }));
    }
  }
}

export function summarizeKpisFromOrders(orders) {
  const payload = buildSalesReportPayload(orders, {});
  return {
    totalRevenue: payload.summary.netRevenue,
    grossRevenue: payload.summary.grossRevenue,
    refundAmount: payload.summary.refundAmount,
    totalOrders: payload.summary.totalOrders,
    totalDiscount: payload.summary.totalDiscounts,
    deliveredOrders: payload.summary.deliveredOrders,
    cancelledOrders: payload.summary.cancelledOrders,
    returnedOrders: payload.summary.returnedOrders,
    pendingOrders: payload.summary.pendingOrders,
  };
}
