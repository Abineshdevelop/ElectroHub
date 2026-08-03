import Order from "../../model/orderModel.js";
import { deriveOrderStatusFromItems } from "../../services/salesRevenueService.js";
import mongoose from "mongoose";
import { buildItemCancellationSafety, validatePartialCancellation } from "../../services/cancellationEligibilityService.js";
import { refundItemsToWallet } from "../user/orderController.js";

const PER_PAGE = 8;

const FORWARD_TRANSITIONS = {
  pending:             ["confirmed", "shipped", "out_for_delivery", "delivered"],
  confirmed:           ["shipped", "out_for_delivery", "delivered"],
  shipped:             ["out_for_delivery", "delivered"],
  out_for_delivery:    ["delivered"],
  delivered:           ["return_requested", "returned"],
  return_requested:    ["returned"],
  partially_cancelled: ["cancelled"],
  cancelled:           [],
  returned:            [],
  expired:             [],
};

export const getOrders = async (req, res) => {
  try {
    const searchQuery = (req.query.q || "").trim();
    const sortOrderParam = req.query.sort || "desc";
    const statusFilter = req.query.status || "all";
    const requestedPage = Number(req.query.page) || 1;
    const isAjaxRequest = req.query.ajax;

    const currentPage = Math.max(1, requestedPage);
    const itemsToSkip = (currentPage - 1) * PER_PAGE;

    const filter = {};

    if (statusFilter !== "all") {
      const itemLevelStatuses = ["return_requested", "returned", "cancelled"];
      if (itemLevelStatuses.includes(statusFilter)) {
        filter["items.status"] = statusFilter;
      } else {
        filter.orderStatus = statusFilter;
      }
    }

    if (searchQuery) {
      filter.$or = [
        { orderId: { $regex: searchQuery, $options: "i" } },
        { "shippingAddress.lastName": { $regex: searchQuery, $options: "i" } },
        { "shippingAddress.email": { $regex: searchQuery, $options: "i" } },
      ];
    }

    const sortDirection = sortOrderParam === "asc" ? 1 : -1;

    const orders = await Order.find(filter)
      .sort({ createdAt: sortDirection })
      .skip(itemsToSkip)
      .limit(PER_PAGE)
      .lean();

    const totalOrders = await Order.countDocuments(filter);

    const totalPages = Math.max(1, Math.ceil(totalOrders / PER_PAGE));
    const showingFrom = totalOrders === 0 ? 0 : itemsToSkip + 1;
    const showingTo = Math.min(itemsToSkip + PER_PAGE, totalOrders);

    if (isAjaxRequest) {//res send by ajax
      return res.json({
        success: true,
        orders: orders,
        total: totalOrders,
        currentPage: currentPage,
        totalPages: totalPages,
        showingFrom: showingFrom,
        showingTo: showingTo,
      });
    }

    return res.render("admin/orders", {
      orders: orders,
      total: totalOrders,
      currentPage: currentPage,
      totalPages: totalPages,
      showingFrom: showingFrom,
      showingTo: showingTo,
      query: searchQuery,
      sort: sortOrderParam,
      statusFilter: statusFilter,
    });
  } catch (error) {
    console.error("Error fetching admin orders list:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};


export const getOrderDetail = async (req, res) => {
  try {
    const orderId = req.params.id;
    const isAjaxRequest = req.query.ajax === "1";

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      if (isAjaxRequest) {
        return res.json({ success: false, message: "Invalid ID." });
      }
      return res.redirect("/admin/orders");
    }

    const order = await Order.findById(orderId)
      .populate("items.productId")
      .populate("items.variantId")
      .lean();

    if (!order) {
      if (isAjaxRequest) {
        return res.json({ success: false, message: "Order not found." });
      }
      return res.redirect("/admin/orders");
    }

    const itemCancellationSafety = await buildItemCancellationSafety(order);

    if (isAjaxRequest) {
      return res.json({
        success: true,
        order: order,
        itemCancellationSafety: itemCancellationSafety,
      });
    }

    return res.render("admin/orders", {
      order: order,
      itemCancellationSafety: itemCancellationSafety,
    });
  } catch (error) {
    console.error("Error fetching order details:", error);
    if (req.query.ajax === "1") {
      return res.status(500).json({ success: false, message: "Server error." });
    }
    return res.redirect("/admin/orders");
  }
};


export const updateItemStatus = async (req, res) => {
  try {
    const { id: orderId, itemId } = req.params;
    const { status: targetStatus } = req.body;

    const allowedStatuses = [
      "pending",
      "confirmed",
      "shipped",
      "out_for_delivery",
      "delivered",
      "cancelled",
      "returned",
    ];

    if (!allowedStatuses.includes(targetStatus)) {
      return res.json({ success: false, message: "Invalid status." });
    }

    if (!mongoose.Types.ObjectId.isValid(orderId) || !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.json({ success: false, message: "Invalid ID." });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.json({ success: false, message: "Order not found." });
    }

    const item = order.items.find((orderItem) => orderItem._id.toString() === itemId);
    if (!item) {
      return res.json({ success: false, message: "Item not found." });
    }

    const currentItemStatus = item.status || order.orderStatus;
    if (targetStatus === currentItemStatus) {
      return res.json({ success: true, message: "Status is already set to " + targetStatus });
    }

    const validNextStatuses = FORWARD_TRANSITIONS[currentItemStatus] || [];
    if (!validNextStatuses.includes(targetStatus)) {
      return res.json({
        success: false,
        message: `Cannot move item status from "${currentItemStatus}" to "${targetStatus}". Only forward transitions are allowed.`,
      });
    }

    const oldItemStatus = item.status;
    const isNewCancellation = ["cancelled", "returned"].includes(targetStatus);
    const belongedToCancellation = ["cancelled", "returned"].includes(oldItemStatus);

    if (isNewCancellation && !belongedToCancellation) {
      const eligibility = await validatePartialCancellation(order, [item]);
      if (!eligibility.allowed) {
        const customMessage = targetStatus === "returned"
          ? "Partial return is not allowed because coupon eligibility will be lost. The remaining order value will fall below the coupon minimum purchase requirement."
          : eligibility.message;

        return res.json({
          success: false,
          message: customMessage,
          maxCancellableAmount: eligibility.maxCancellableAmount,
          remainingSubtotal: eligibility.remainingSubtotal,
          minPurchaseAmount: eligibility.minPurchaseAmount,
        });
      }
    }

    item.status = targetStatus;

    if (isNewCancellation && !belongedToCancellation) {
      const Variant = (await import("../../model/variantModel.js")).default;
      const validPaymentStatesForStock = ["paid", "partially_refunded", "refunded", "adjusted"];
      const shouldRestoreStock = order.paymentMethod === "cod" || validPaymentStatesForStock.includes(order.paymentStatus);

      if (shouldRestoreStock) {
        await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
      }

      await refundItemsToWallet(
        order,
        [item],
        `Refund for admin ${targetStatus} item "${item.productName}" in order #${order.orderId}`
      );
    }

    for (const orderItem of order.items) {
      if (orderItem.finalAmount == null) {
        orderItem.finalAmount = orderItem.lineTotal ?? 0;
      }
    }

    order.orderStatus = deriveOrderStatusFromItems(order.items);
    if (order.orderStatus === "delivered" && !["paid", "partially_refunded", "refunded"].includes(order.paymentStatus)) {
      order.paymentStatus = "paid";
    }

    await order.save();
    return res.json({
      success: true,
      itemStatus: item.status,
      orderStatus: order.orderStatus,
    });
  } catch (error) {
    console.error("Error updating item status:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

export const deleteOrder = async (req, res) => {
  try {
    const orderId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.json({ success: false, message: "Invalid ID." });
    }

    const order = await Order.findByIdAndDelete(orderId);
    if (!order) {
      return res.json({ success: false, message: "Order not found." });
    }

    return res.json({ success: true, message: "Order deleted successfully." });
  } catch (error) {
    console.error("Error deleting order:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

export const approveReturn = async (req, res) => {
  try {
    const orderId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.json({ success: false, message: "Invalid order ID." });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.json({ success: false, message: "Order not found." });
    }

    const returnItems = order.items.filter((item) => item.status === "return_requested");
    if (returnItems.length === 0) {
      return res.json({ success: false, message: "No pending return requests found." });
    }

    const eligibility = await validatePartialCancellation(order, returnItems);
    if (!eligibility.allowed) {
      return res.json({
        success: false,
        message: "Return cannot be approved because coupon eligibility will be lost. The remaining order value will fall below the coupon minimum purchase requirement.",
        maxCancellableAmount: eligibility.maxCancellableAmount,
        remainingSubtotal: eligibility.remainingSubtotal,
        minPurchaseAmount: eligibility.minPurchaseAmount,
      });
    }

    const currentDate = new Date();
    const Variant = (await import("../../model/variantModel.js")).default;

    for (const item of returnItems) {
      item.status = "returned";
      item.returnApprovedAt = currentDate;
      await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
    }

    const refundedAmount = await refundItemsToWallet(
      order,
      returnItems,
      `Refund for approved return on order #${order.orderId}`
    );

    // Step 7: Recalculate overall order status
    const allItemStatuses = order.items.map((item) => item.status);
    const allItemsFinished = allItemStatuses.every((status) => ["returned", "cancelled"].includes(status));

    if (allItemsFinished) {
      order.orderStatus = "returned";
    } else {
      const hasActiveItems = allItemStatuses.some((status) => !["returned", "cancelled"].includes(status));
      order.orderStatus = hasActiveItems ? order.orderStatus : "returned";
    }

    // Step 8: Save updated order and return success response
    await order.save();
    const successMessage = refundedAmount > 0
      ? "Return approved. Refund issued to customer wallet."
      : "Return approved.";

    return res.json({
      success: true,
      message: successMessage,
      orderStatus: order.orderStatus,
    });
  } catch (error) {
    console.error("Error in approveReturn:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

export const rejectReturn = async (req, res) => {
  try {
    const orderId = req.params.id;
    const rejectionReason = req.body.reason;

    if (!rejectionReason || !rejectionReason.trim()) {
      return res.json({ success: false, message: "Please provide a rejection reason." });
    }

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.json({ success: false, message: "Invalid order ID." });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.json({ success: false, message: "Order not found." });
    }

    const returnItems = order.items.filter((item) => item.status === "return_requested");
    if (returnItems.length === 0) {
      return res.json({ success: false, message: "No pending return requests found." });
    }

    const currentDate = new Date();
    for (const item of returnItems) {
      item.status = "return_rejected";
      item.returnRejectedAt = currentDate;
      item.returnRejectionReason = rejectionReason.trim();
    }

    const allItemStatuses = order.items.map((item) => item.status);
    const hasActiveItems = allItemStatuses.some(
      (status) => !["cancelled", "returned", "return_rejected", "delivered"].includes(status)
    );

    if (!hasActiveItems) {
      const allRejectedOrCancelled = allItemStatuses.every(
        (status) => status === "return_rejected" || status === "cancelled"
      );
      order.orderStatus = allRejectedOrCancelled ? "return_rejected" : "delivered";
    }

    await order.save();

    return res.json({
      success: true,
      message: "Return request rejected.",
      orderStatus: order.orderStatus,
    });
  } catch (error) {
    console.error("Error in rejectReturn:", error);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
