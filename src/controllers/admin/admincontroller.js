import Order from "../../model/orderModel.js";
import User from "../../model/usermodel.js";
import { AppError } from "../../errors/appError.js";
import {
  resolveDateRange,
  summarizeKpisFromOrders,
  buildChartSeriesFromOrders,
  buildSalesReportPayload,
  buildDashboardGroupedCounts,
  classifyOrderBucket,
} from "../../services/salesRevenueService.js";
import {
  generateSalesPDFReport,
  generateSalesExcelReport,
} from "../../services/salesReportExportService.js";

const getDashboardMatch = (filter) => {
  const range = resolveDateRange({ filterType: filter });
  return {
    orderStatus: { $nin: ["expired"] },
    ...range.mongoMatch,
  };
};

export const showLogin = (req, res) => {
  if (req.session.admin) return res.redirect("/admin/dashboard");
  res.render("admin/auth/login", { title: "Admin Login" });
};

export const loginAdmin = async (req, res, next) => {
  try {
    const email = (req.body.email || "").trim();
    const password = (req.body.password || "").trim();
    if (!email || !password) {
      throw new AppError(400, "Email and Password Required");
    }

    const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      return res.status(500).json({ success: false, message: "Admin credentials not configured" });
    }

    if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      req.session.admin = {
        email,
        role: "admin",
        loggedInAt: Date.now(),
      };

      return req.session.save((error) => {
        if (error) console.error("Session save error during admin login:", error);
        return res.json({ success: true });
      });
    }

    return res.json({ success: false, message: "Invalid admin credentials" });
  } catch (error) {
    next(error);
  }
};

export const adminDashboard = async (req, res) => {
  try {
    if (!req.session.admin) return res.redirect("/admin/login");

    const filter = req.query.filter || "monthly";
    const baseMatch = getDashboardMatch(filter);

    const ordersForKpiPromise = Order.find(baseMatch)
      .populate("userId", "firstName lastName email")
      .lean();

    // Status Counts (Overall)
    const statusCountsPromise = Order.aggregate([
      { $group: {
          _id: "$orderStatus",
          count: { $sum: 1 }
      }}
    ]);

    const userCountPromise = User.countDocuments({ deletedAt: null, isAdmin: false });

    const topProductsPromise = Order.aggregate([
      { $match: baseMatch },
      { $unwind: "$items" },
      { $match: { "items.status": "delivered" } },
      { $group: {
          _id:   "$items.productId",
          name:  { $first: "$items.productName" },
          count: { $sum: "$items.quantity" }
      }},
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const topCategoriesPromise = Order.aggregate([
      { $match: baseMatch },
      { $unwind: "$items" },
      { $match: { "items.status": "delivered" } },
      { $lookup: {
          from: "products",
          localField: "items.productId",
          foreignField: "_id",
          as: "product"
      }},
      { $unwind: "$product" },
      { $lookup: {
          from: "categories",
          localField: "product.categoryId",
          foreignField: "_id",
          as: "category"
      }},
      { $unwind: "$category" },
      { $group: {
          _id: "$category._id",
          name: { $first: "$category.categoryName" },
          count: { $sum: "$items.quantity" }
      }},
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const topBrandsPromise = Order.aggregate([
      { $match: baseMatch },
      { $unwind: "$items" },
      { $match: { "items.status": "delivered" } },
      { $lookup: {
          from: "products",
          localField: "items.productId",
          foreignField: "_id",
          as: "product"
      }},
      { $unwind: "$product" },
      { $group: {
          _id: "$product.brandName",
          count: { $sum: "$items.quantity" }
      }},
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const recentOrdersPromise = Order.find(baseMatch)
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('userId', 'firstName lastName email')
      .lean();

    const [ordersForKpi, statusCountsRaw, totalCustomers, topProducts, topCategories, topBrands, recentOrders] = await Promise.all([
      ordersForKpiPromise,
      statusCountsPromise,
      userCountPromise,
      topProductsPromise,
      topCategoriesPromise,
      topBrandsPromise,
      recentOrdersPromise,
    ]);

    const kpi = summarizeKpisFromOrders(ordersForKpi);
    const chartData = buildChartSeriesFromOrders(ordersForKpi, filter).slice(-12);
    const statusCounts = {};
    statusCountsRaw.forEach((statusEntry) => {
      statusCounts[statusEntry._id] = statusEntry.count || 0;
    });

    const groupedCounts = buildDashboardGroupedCounts(ordersForKpi);

    const recentOrdersEnriched = recentOrders.map((order) => ({
      ...order,
      dashboardBucket: classifyOrderBucket(order),
    }));

    const deliveredOrderCount = kpi.deliveredOrders || groupedCounts.completed || 0;
    const averageOrderValue = deliveredOrderCount > 0 ? (kpi.totalRevenue / deliveredOrderCount) : 0;

    res.render("admin/auth/dashboard", {
      title: "Admin Dashboard",
      admin: req.session.admin,
      kpi,
      statusCounts,
      groupedCounts,
      aov: averageOrderValue,
      totalCustomers,
      chartData,
      topProducts,
      topCategories,
      topBrands,
      recentOrders: recentOrdersEnriched,
      currentFilter: filter
    });

  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).send("Failed to load dashboard");
  }
};

export const logoutAdmin = (req, res) => {
  delete req.session.admin;
  req.session.save((error) => {
    if (error) console.error("Session save error during admin logout:", error);
    res.redirect("/admin/login");
  });
};

export const downloadPDF = async (req, res) => {
  try {
    const filter = req.query.filter || "monthly";
    const match = getDashboardMatch(filter);
    const orders = await Order.find(match)
      .populate("userId", "firstName lastName email")
      .sort({ createdAt: -1 })
      .lean();
    const dateRange = resolveDateRange({ filterType: filter });
    const payload = buildSalesReportPayload(orders, {
      dateRange,
      generatedBy: req.session.admin?.email || "Admin",
    });
    payload.meta.title = "Dashboard Sales Report";
    const stamp = new Date().toISOString().split("T")[0];
    generateSalesPDFReport(res, payload, `ElectroHub_Dashboard_Report_${stamp}`);
  } catch (error) {
    console.error("Dashboard PDF error:", error);
    res.status(500).send("Failed to generate PDF");
  }
};

export const downloadExcel = async (req, res) => {
  try {
    const filter = req.query.filter || "monthly";
    const match = getDashboardMatch(filter);
    const orders = await Order.find(match)
      .populate("userId", "firstName lastName email")
      .sort({ createdAt: -1 })
      .lean();
    const dateRange = resolveDateRange({ filterType: filter });
    const payload = buildSalesReportPayload(orders, {
      dateRange,
      generatedBy: req.session.admin?.email || "Admin",
    });
    payload.meta.title = "Dashboard Sales Report";
    const stamp = new Date().toISOString().split("T")[0];
    await generateSalesExcelReport(res, payload, `ElectroHub_Dashboard_Report_${stamp}`);
  } catch (error) {
    console.error("Dashboard Excel error:", error);
    res.status(500).send("Failed to generate Excel");
  }
};

export default {
  showLogin,
  loginAdmin,
  adminDashboard,
  logoutAdmin,
  downloadPDF,
  downloadExcel
};
