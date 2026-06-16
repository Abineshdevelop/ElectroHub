import Order from "../../model/orderModel.js";
import {
  getOrderListMatch,
  resolveDateRange,
  buildSalesReportPayload,
  buildChartSeriesFromOrders,
  summarizeKpisFromOrders,
} from "../../services/salesRevenueService.js";
import {
  generateSalesPDFReport,
  generateSalesExcelReport,
} from "../../services/salesReportExportService.js";

const deliveredItemMatch = { "items.status": "delivered" };

export const getSalesReport = async (req, res) => {
  try {
    if (!req.session.admin) return res.redirect("/admin/login");

    const dateRange = resolveDateRange(req.query);
    const match = { ...getOrderListMatch(req.query) };

    const ordersPromise = Order.find(match)
      .sort({ createdAt: -1 })
      .populate("userId", "firstName lastName email")
      .lean();

    const topCategoriesPromise = Order.aggregate([
      { $match: match },
      { $unwind: "$items" },
      { $match: deliveredItemMatch },
      {
        $lookup: {
          from: "products",
          localField: "items.productId",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: "$product" },
      {
        $lookup: {
          from: "categories",
          localField: "product.categoryId",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: "$category" },
      {
        $group: {
          _id: "$category.categoryName",
          count: { $sum: "$items.quantity" },
          revenue: {
            $sum: {
              $ifNull: [
                "$items.finalAmount",
                { $ifNull: ["$items.lineTotal", 0] },
              ],
            },
          },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 10 },
    ]);

    const topProductsPromise = Order.aggregate([
      { $match: match },
      { $unwind: "$items" },
      { $match: deliveredItemMatch },
      {
        $group: {
          _id: "$items.productId",
          name: { $first: "$items.productName" },
          count: { $sum: "$items.quantity" },
          revenue: {
            $sum: {
              $ifNull: [
                "$items.finalAmount",
                { $ifNull: ["$items.lineTotal", 0] },
              ],
            },
          },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 10 },
    ]);

    const [orders, topCategoriesRaw, topProductsRaw] = await Promise.all([
      ordersPromise,
      topCategoriesPromise,
      topProductsPromise,
    ]);

    const kpi = summarizeKpisFromOrders(orders);
    const chartData = buildChartSeriesFromOrders(orders, dateRange.filterType, req.query);

    const topCategories = topCategoriesRaw.map((category) => ({
      _id: category._id,
      count: category.count,
      revenue: Math.round(category.revenue || 0),
    }));

    const topProducts = topProductsRaw.map((product) => ({
      name: product.name,
      count: product.count,
      revenue: Math.round(product.revenue || 0),
    }));

    res.render("admin/auth/salesReport", {
      title: "Sales Report",
      admin: req.session.admin,
      kpi,
      chartData,
      topCategories,
      topProducts,
      orders,
      query: req.query,
      dateRange,
    });
  } catch (error) {
    console.error("Sales Report error:", error);
    res.status(500).send("Failed to generate sales report");
  }
};

async function fetchReportPayload(req) {
  const match = getOrderListMatch(req.query);
  const orders = await Order.find(match)
    .sort({ createdAt: -1 })
    .populate("userId", "firstName lastName email")
    .lean();

  const dateRange = resolveDateRange(req.query);
  const generatedBy = req.session.admin?.email || "Admin";

  const payload = buildSalesReportPayload(orders, { dateRange, generatedBy, query: req.query });

  const topCategoriesAgg = await Order.aggregate([
    { $match: match },
    { $unwind: "$items" },
    { $match: deliveredItemMatch },
    {
      $lookup: {
        from: "products",
        localField: "items.productId",
        foreignField: "_id",
        as: "product",
      },
    },
    { $unwind: "$product" },
    {
      $lookup: {
        from: "categories",
        localField: "product.categoryId",
        foreignField: "_id",
        as: "category",
      },
    },
    { $unwind: "$category" },
    {
      $group: {
        _id: "$category.categoryName",
        name: { $first: "$category.categoryName" },
        units: { $sum: "$items.quantity" },
        revenue: {
          $sum: {
            $ifNull: ["$items.finalAmount", { $ifNull: ["$items.lineTotal", 0] }],
          },
        },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: 15 },
  ]);

  if (topCategoriesAgg.length) {
    payload.topCategories = topCategoriesAgg.map((category) => ({
      name: category.name || category._id,
      units: category.units,
      revenue: Math.round(category.revenue || 0),
    }));
  }

  return payload;
}

export const downloadPDF = async (req, res) => {
  try {
    const payload = await fetchReportPayload(req);
    const stamp = new Date().toISOString().split("T")[0];
    generateSalesPDFReport(res, payload, `ElectroHub_Sales_Report_${stamp}`);
  } catch (error) {
    console.error("PDF Download error:", error);
    res.status(500).send("Failed to generate PDF");
  }
};

export const downloadExcel = async (req, res) => {
  try {
    const payload = await fetchReportPayload(req);
    const stamp = new Date().toISOString().split("T")[0];
    await generateSalesExcelReport(res, payload, `ElectroHub_Sales_Report_${stamp}`);
  } catch (error) {
    console.error("Excel Download error:", error);
    res.status(500).send("Failed to generate Excel");
  }
};
