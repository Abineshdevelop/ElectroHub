import Order    from "../../model/orderModel.js";
import User     from "../../model/usermodel.js";
import { AppError } from "../../errors/appError.js";

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
      return res
        .status(500)
        .json({ success: false, message: "Admin credentials not configured" });
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
    const now    = new Date();
    
    // Define Date Match based on filter
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

    const baseMatch = { 
        orderStatus: { $nin: ['cancelled', 'returned', 'return_requested', 'expired'] },
        ...dateMatch
    };
    
    // 1. KPI Aggregations (Filtered)
    const kpiPromise = Order.aggregate([
      { $match: baseMatch },
      { $group: {
          _id:          null,
          totalRevenue: { $sum: "$totalAmount" },
          totalOrders:  { $sum: 1 }
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
          revenue: { $sum: "$totalAmount" },
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

    const [kpis, statusCountsRaw, totalCustomers, chartData, topProducts, topCategories, topBrands] = await Promise.all([
      kpiPromise,
      statusCountsPromise,
      userCountPromise,
      chartDataPromise,
      topProductsPromise,
      topCategoriesPromise,
      topBrandsPromise
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
      currentFilter: filter
    });

  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).render("error", { title: "Error", message: "Failed to load dashboard" });
  }
};

export const logoutAdmin = (req, res) => {
  delete req.session.admin;
  req.session.save((err) => {
    if (err) console.error("Session save error during admin logout:", err);
    res.redirect("/admin/login");
  });
};

export default {
  showLogin,
  loginAdmin,
  adminDashboard,
  logoutAdmin,
};
