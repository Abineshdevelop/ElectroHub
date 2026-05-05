import Order from "../../model/orderModel.js";
import User from "../../model/usermodel.js";
import { AppError } from "../../errors/appError.js";
import * as reportService from "../../services/reportService.js";

const getDashboardMatch = (filter) => {
  const now = new Date();
  let dateMatch = {};
  if (filter === 'daily') {
    const start = new Date(); start.setHours(0,0,0,0);
    dateMatch.createdAt = { $gte: start };
  } else if (filter === 'weekly') {
    const start = new Date(); start.setDate(now.getDate() - 7);
    dateMatch.createdAt = { $gte: start };
  } else if (filter === 'monthly') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    dateMatch.createdAt = { $gte: start };
  } else if (filter === 'yearly') {
    const start = new Date(now.getFullYear(), 0, 1);
    dateMatch.createdAt = { $gte: start };
  }

  return { 
      orderStatus: { $nin: ['cancelled', 'returned', 'return_requested', 'expired'] },
      ...dateMatch
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
      throw new AppError(400, "Email and Password Required")
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

      return req.session.save((err) => {
        if (err) console.error("Session save error during admin login:", err);
        return res.json({ success: true });
      });
    }

    return res.json({ success: false, message: "Invalid admin credentials" });
  } catch (err) {
    next(err)
  }
};

export const adminDashboard = async (req, res) => {
  try {
    if (!req.session.admin) return res.redirect("/admin/login");

    const filter = req.query.filter || 'monthly';
    const baseMatch = getDashboardMatch(filter);
    
    // 1. KPI Aggregations (Filtered)
    const kpiPromise = Order.aggregate([
      { $match: baseMatch },
      { $group: {
          _id: null,
          totalRevenue: { 
            $sum: {
              $cond: [
                { $or: [
                  { $eq: ["$orderStatus", "delivered"] },
                  { $and: [
                    { $eq: ["$paymentStatus", "paid"] },
                    { $not: [{ $in: ["$orderStatus", ["cancelled", "returned", "return_requested", "return_rejected"]] }] }
                  ]}
                ]},
                "$totalAmount",
                0
              ]
            }
          },
          totalOrders: { $sum: 1 }
      }}
    ]);

    // 2. Status Counts (Overall)
    const statusCountsPromise = Order.aggregate([
      { $group: {
          _id: "$orderStatus",
          count: { $sum: 1 }
      }}
    ]);

    const userCountPromise = User.countDocuments({ deletedAt: null, isAdmin: false });

    // 3. Chart Data Aggregation (Revenue Trend Analysis)
    let dateGroup = "%Y-%m-%d"; 
    if (filter === 'yearly')      dateGroup = "%Y";
    else if (filter === 'monthly') dateGroup = "%Y-%m";
    else if (filter === 'weekly')  dateGroup = "Week %U"; // Better label for weekly

    const chartDataPromise = Order.aggregate([
      { $match: baseMatch },
      { $group: {
          _id:     { $dateToString: { format: dateGroup, date: "$createdAt" } },
          revenue: { 
            $sum: {
              $cond: [
                { $or: [
                  { $eq: ["$orderStatus", "delivered"] },
                  { $and: [
                    { $eq: ["$paymentStatus", "paid"] },
                    { $not: [{ $in: ["$orderStatus", ["cancelled", "returned", "return_requested", "return_rejected"]] }] }
                  ]}
                ]},
                "$totalAmount",
                0
              ]
            }
          },
          count:   { $sum: 1 }
      }},
      { $sort: { "_id": 1 } },
      { $limit: 12 }
    ]);

    // 4. Top 10 Best Sellers (Filtered)
    const topProductsPromise = Order.aggregate([
      { $match: baseMatch },
      { $unwind: "$items" },
      { $match: { "items.status": { $nin: ['cancelled', 'returned', 'return_requested'] } } },
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
      { $match: { "items.status": { $nin: ['cancelled', 'returned', 'return_requested'] } } },
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
          name: { $first: "$category.categoryName" }, // FIXED: categoryName instead of name
          count: { $sum: "$items.quantity" }
      }},
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    const topBrandsPromise = Order.aggregate([
      { $match: baseMatch },
      { $unwind: "$items" },
      { $match: { "items.status": { $nin: ['cancelled', 'returned', 'return_requested'] } } },
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

    const [kpis, statusCountsRaw, totalCustomers, chartData, topProducts, topCategories, topBrands, recentOrders] = await Promise.all([
      kpiPromise,
      statusCountsPromise,
      userCountPromise,
      chartDataPromise,
      topProductsPromise,
      topCategoriesPromise,
      topBrandsPromise,
      recentOrdersPromise
    ]);

    const kpi = kpis[0] || { totalRevenue: 0, totalOrders: 0 };
    const statusCounts = {};
    statusCountsRaw.forEach(s => statusCounts[s._id] = s.count || 0);

    // Grouping logic for dashboard KPIs
    const groupedCounts = {
      completed: statusCounts['delivered'] || 0,
      closed: statusCounts['cancelled'] || 0,
      reverse: (statusCounts['returned'] || 0) + (statusCounts['return_requested'] || 0),
      pending: 0
    };

    // All other active statuses are "pending" from admin's perspective
    const nonPending = ['delivered', 'cancelled', 'returned', 'return_requested', 'expired'];
    Object.keys(statusCounts).forEach(s => {
      if (!nonPending.includes(s)) {
        groupedCounts.pending += statusCounts[s];
      }
    });

    const aov = kpi.totalOrders > 0 ? (kpi.totalRevenue / kpi.totalOrders) : 0;

    res.render("admin/auth/dashboard", {
      title: "Admin Dashboard",
      admin: req.session.admin,
      kpi,
      statusCounts,
      groupedCounts, // New grouped counts
      aov,
      totalCustomers,
      chartData,
      topProducts,
      topCategories,
      topBrands,
      recentOrders,
      currentFilter: filter
    });

  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).send("Failed to load dashboard");
  }
};

export const logoutAdmin = (req, res) => {
  delete req.session.admin;
  req.session.save((err) => {
    if (err) console.error("Session save error during admin logout:", err);
    res.redirect("/admin/login");
  });
};

export const downloadPDF = async (req, res) => {
  try {
    const filter = req.query.filter || 'monthly';
    const match = getDashboardMatch(filter);
    const orders = await Order.find(match).populate('userId', 'firstName lastName').sort({ createdAt: -1 }).limit(10).lean();
    
    const data = orders.map(o => ({
      orderId: o.orderId,
      customer: `${o.userId?.firstName || ''} ${o.userId?.lastName || ''}`,
      date: new Date(o.createdAt).toLocaleDateString('en-IN'),
      status: o.orderStatus,
      paymentMethod: o.paymentMethod,
      products: o.items.map(i => `${i.productName} - ${i.quantity} qty`).join('\n'),
      revenue: o.totalAmount
    }));

    await reportService.generatePDFReport(res, data, 'ElectroHub_Dashboard_Report', 'Dashboard Recent Transactions');
  } catch (err) {
    console.error("Dashboard PDF error:", err);
    res.status(500).send("Failed to generate PDF");
  }
};

export const downloadExcel = async (req, res) => {
  try {
    const filter = req.query.filter || 'monthly';
    const match = getDashboardMatch(filter);
    const orders = await Order.find(match).populate('userId', 'firstName lastName').sort({ createdAt: -1 }).limit(10).lean();
    
    const data = orders.map(o => ({
      orderId: o.orderId,
      customer: `${o.userId?.firstName || ''} ${o.userId?.lastName || ''}`,
      date: new Date(o.createdAt).toLocaleDateString('en-IN'),
      status: o.orderStatus,
      paymentMethod: o.paymentMethod,
      products: o.items.map(i => `${i.productName} - ${i.quantity} qty`).join('\n'),
      revenue: o.totalAmount
    }));

    await reportService.generateExcelReport(res, data, 'ElectroHub_Dashboard_Report');
  } catch (err) {
    console.error("Dashboard Excel error:", err);
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
