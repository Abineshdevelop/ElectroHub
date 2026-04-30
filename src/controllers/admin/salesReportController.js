import Order from "../../model/orderModel.js";
import User from "../../model/usermodel.js";
import { AppError } from "../../errors/appError.js";

export const getSalesReport = async (req, res) => {
  try {
    if (!req.session.admin) return res.redirect("/admin/login");

    const { startDate, endDate, filterType = 'monthly' } = req.query;
    let match = { orderStatus: { $nin: ['cancelled', 'returned', 'return_requested', 'expired'] } };

    // Date Filtering Logic
    if (startDate && endDate) {
      match.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    } else if (filterType === 'daily') {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      match.createdAt = { $gte: start };
    } else if (filterType === 'weekly') {
      const start = new Date(); start.setDate(start.getDate() - 7);
      match.createdAt = { $gte: start };
    } else if (filterType === 'yearly') {
      const start = new Date(new Date().getFullYear(), 0, 1);
      match.createdAt = { $gte: start };
    } else {
      // Monthly default
      const start = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      match.createdAt = { $gte: start };
    }

    // 1. KPIs: Revenue, Orders, Discounts
    const kpiPromise = Order.aggregate([
      { $match: match },
      { $group: {
          _id:           null,
          totalRevenue:  { $sum: "$totalAmount" },
          totalOrders:   { $sum: 1 },
          totalDiscount: { $sum: "$discount" }
      }}
    ]);

    // 2. Chart Data (Revenue Trend)
    const chartDataPromise = Order.aggregate([
      { $match: match },
      { $group: {
          _id:     { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: "$totalAmount" }
      }},
      { $sort: { "_id": 1 } }
    ]);

    // 3. Top Categories
    const topCategoriesPromise = Order.aggregate([
      { $match: match },
      { $unwind: "$items" },
      { $match: { "items.status": { $nin: ['cancelled', 'returned', 'return_requested'] } } },
      { $lookup: {
          from:         "products",
          localField:   "items.productId",
          foreignField: "_id",
          as:           "product"
      }},
      { $unwind: "$product" },
      { $lookup: {
          from:         "categories",
          localField:   "product.categoryId",
          foreignField: "_id",
          as:           "category"
      }},
      { $unwind: "$category" },
      { $group: {
          _id:   "$category.categoryName",
          count: { $sum: "$items.quantity" }
      }},
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // 4. Order List for Table
    const ordersPromise = Order.find(match)
      .sort({ createdAt: -1 })
      .populate('userId', 'firstName lastName email')
      .lean();

    const [kpis, chartData, topCategories, orders] = await Promise.all([
      kpiPromise,
      chartDataPromise,
      topCategoriesPromise,
      ordersPromise
    ]);

    const kpi = kpis[0] || { totalRevenue: 0, totalOrders: 0, totalDiscount: 0 };

    res.render("admin/auth/salesReport", {
      title: "Sales Report",
      admin: req.session.admin,
      kpi,
      chartData,
      topCategories,
      orders,
      query: req.query
    });

  } catch (err) {
    console.error("Sales Report error:", err);
    res.status(500).render("error", { title: "Error", message: "Failed to generate sales report" });
  }
};
