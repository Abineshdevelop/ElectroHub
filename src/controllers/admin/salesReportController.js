import Order from "../../model/orderModel.js";
import User from "../../model/usermodel.js";
import { AppError } from "../../errors/appError.js";
import * as reportService from "../../services/reportService.js";

const getMatchFilter = (query) => {
  const { startDate, endDate, filterType = 'monthly' } = query;
  let match = { orderStatus: { $nin: ['cancelled', 'returned', 'return_requested', 'expired'] } };

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
    const start = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    match.createdAt = { $gte: start };
  }
  return match;
};

export const getSalesReport = async (req, res) => {
  try {
    if (!req.session.admin) return res.redirect("/admin/login");

    const match = getMatchFilter(req.query);

    // 1. KPIs: Revenue, Orders, Discounts
    const kpiPromise = Order.aggregate([
      { $match: match },
      { $group: {
          _id:           null,
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
          totalOrders:   { $sum: 1 },
          totalDiscount: { $sum: "$discount" }
      }}
    ]);

    // 2. Chart Data (Revenue Trend)
    const chartDataPromise = Order.aggregate([
      { $match: match },
      { $group: {
          _id:     { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
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
          }
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
    res.status(500).send("Failed to generate sales report");
  }
};

export const downloadPDF = async (req, res) => {
  try {
    const match = getMatchFilter(req.query);
    const orders = await Order.find(match).populate('userId', 'firstName lastName').sort({ createdAt: -1 }).lean();
    
    const data = orders.map(o => ({
      orderId: o.orderId,
      customer: `${o.userId?.firstName || ''} ${o.userId?.lastName || ''}`,
      date: new Date(o.createdAt).toLocaleDateString('en-IN'),
      status: o.orderStatus,
      paymentMethod: o.paymentMethod,
      products: o.items.map(i => `${i.productName} - ${i.quantity} qty`).join('\n'),
      revenue: o.totalAmount
    }));

    await reportService.generatePDFReport(res, data, 'ElectroHub_Sales_Report', 'Sales & Revenue Report');
  } catch (err) {
    console.error("PDF Download error:", err);
    res.status(500).send("Failed to generate PDF");
  }
};

export const downloadExcel = async (req, res) => {
  try {
    const match = getMatchFilter(req.query);
    const orders = await Order.find(match).populate('userId', 'firstName lastName').sort({ createdAt: -1 }).lean();
    
    const data = orders.map(o => ({
      orderId: o.orderId,
      customer: `${o.userId?.firstName || ''} ${o.userId?.lastName || ''}`,
      date: new Date(o.createdAt).toLocaleDateString('en-IN'),
      status: o.orderStatus,
      paymentMethod: o.paymentMethod,
      products: o.items.map(i => `${i.productName} - ${i.quantity} qty`).join('\n'),
      revenue: o.totalAmount
    }));

    await reportService.generateExcelReport(res, data, 'ElectroHub_Sales_Report');
  } catch (err) {
    console.error("Excel Download error:", err);
    res.status(500).send("Failed to generate Excel");
  }
};
