import mongoose from "mongoose";
import Order from "../../model/orderModel.js";
import Variant from "../../model/variantModel.js";
import { buildItemCancellationSafety, getActiveItems, getItemsSubtotal, getMaximumCancellableAmount, validatePartialCancellation } from "../../services/cancellationEligibilityService.js";
import { releaseCouponUsage } from "../../services/couponValidationService.js";
import { recalculateOrderStatus } from "../../services/orderRecalculationService.js";
import { refundItemsToWallet } from "../../services/orderRefundService.js";

//if the orders are partially cancelled other active items are keep confirmed
function getEffectiveStatus(item, orderStatus) {
  if (
    item.status &&
    !["pending", "partially_cancelled"].includes(item.status)
  ) {
    return item.status;
  }

  if (["partially_cancelled", "cancelled"].includes(orderStatus)) {
    return "confirmed";
  }
  return orderStatus;
}

export const getOrderHistory = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const { tab = "all" } = req.query;

    const filter = { userId };
    if (tab === "pending")
      filter.orderStatus = { $in: ["confirmed"] };
    if (tab === "completed") filter.orderStatus = "delivered";
    if (tab === "cancelled")
      filter.orderStatus = { $in: ["cancelled", "partially_cancelled"] };
    if (tab === "returned") filter.orderStatus = "returned";

    const orders = await Order.find(filter)
      .populate("items.productId")
      .populate("items.variantId")
      .sort({ createdAt: -1 })
      .lean();

    const [
      allCount,
      pendingCount,
      completedCount,
      cancelledCount,
      returnedCount,
    ] = await Promise.all([
      Order.countDocuments({ userId }),
      Order.countDocuments({
        userId,
        orderStatus: { $in: ["confirmed"] },
      }),
      Order.countDocuments({ userId, orderStatus: "delivered" }),
      Order.countDocuments({
        userId,
        orderStatus: { $in: ["cancelled", "partially_cancelled"] },
      }),
      Order.countDocuments({ userId, orderStatus: "returned" }),
    ]);

    res.render("user/orderStatus/orders", {
      user: req.session.user,
      orders,
      activeTab: tab,
      counts: {
        allCount,
        pendingCount,
        completedCount,
        cancelledCount,
        returnedCount,
      },
    });
  } catch (error) {
    console.error("getOrderHistory error:", error);
    res.redirect("/user/home");
  }
};

export const getOrderDetails = async (req, res) => {
  try {
    const { orderId } = req.params;

    // Validate the order ID format
    if (!mongoose.Types.ObjectId.isValid(orderId))
      return res.redirect("/user/orders");

    const userId = req.session.user._id;
    
    // Fetch the order document along with populated product and variant details
    const orderDetails = await Order.findOne({ _id: orderId, userId })
      .populate("items.productId")
      .populate("items.variantId")
      .lean();

    // Redirect to orders page if the order is not found
    if (!orderDetails) return res.redirect("/user/orders");

    // Calculate the subtotal of currently active items (not cancelled/returned)
    const currentActiveSubtotal = getItemsSubtotal(getActiveItems(orderDetails));
    
    // Retrieve the minimum purchase amount required by the applied coupon (if any)
    const requiredMinPurchase = Number(orderDetails.couponSnapshot?.minPurchaseAmount || 0);

    // Render the details page with all required safety check context
    res.render("user/orderStatus/orderDetails", {
      user: req.session.user,
      order: orderDetails,
      cancellationSafety: {
        activeSubtotal: currentActiveSubtotal,
        minPurchaseAmount: requiredMinPurchase,
        maxCancellableAmount: getMaximumCancellableAmount(orderDetails),
      },
      itemCancellationSafety: await buildItemCancellationSafety(orderDetails),
    });
  } catch (error) {
    console.error("getOrderDetails error:", error);
    res.redirect("/user/orders");
  }
};

export const cancelOrder = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const { orderId } = req.params;
    const { reason, itemId } = req.body;
    const trimmedReason = reason?.trim();

    if (!mongoose.Types.ObjectId.isValid(orderId))
      return res.json({ success: false, message: "Invalid order ID" });

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) return res.json({ success: false, message: "Order not found" });

    //item cancel
    if (itemId) {
      const item = order.items.find((item) => item._id.toString() === itemId);
      if (!item)
        return res.json({ success: false, message: "Item not found in order" });

      if (item.status === "cancelled")
        return res.json({ success: false, message: "Item already cancelled" });

      const effectiveItemStatus = getEffectiveStatus(item, order.orderStatus);
      if (!["confirmed", "shipped"].includes(effectiveItemStatus))
        return res.json({
          success: false,
          message: effectiveItemStatus === "out_for_delivery" || effectiveItemStatus === "delivered" 
            ? "Item cannot be cancelled it is out for delivery" 
            : `Item cannot be cancelled at this stage (${effectiveItemStatus})`,
        });

      const eligibility = await validatePartialCancellation(order, [item]);
      if (!eligibility.allowed) {
        return res.json({
          success: false,
          message: eligibility.message,
          maxCancellableAmount: eligibility.maxCancellableAmount,
          remainingSubtotal: eligibility.remainingSubtotal,
          minPurchaseAmount: eligibility.minPurchaseAmount,
        });
      }

      if (!trimmedReason)
        return res.json({
          success: false,
          message: "Please provide a cancellation reason",
        });

      if (trimmedReason.length < 6)
        return res.json({
          success: false,
          message: "Please enter a reason with least 6 characters.",
        });

      const shouldRestoreStock = order.paymentMethod === "cod" || ["paid", "partially_refunded", "refunded", "adjusted"].includes(order.paymentStatus);

      // Mark item cancelled in memory before calculating remaining payable amount.
      item.status = "cancelled";
      item.cancelReason = trimmedReason;
      item.cancelledAt = new Date();

      const refundAmount = await refundItemsToWallet(
        order,
        [item],
        `Refund for cancelled item "${item.productName}" in order #${order.orderId}`,
      );

      if (shouldRestoreStock) {
        await Variant.findByIdAndUpdate(item.variantId, {
          $inc: { stock: item.quantity },
        });
      }

      recalculateOrderStatus(order);
      if (order.orderStatus === "cancelled") {
        order.cancelReason = trimmedReason;
        order.cancelledAt = new Date();
        await releaseCouponUsage(order);
      }

      await order.save();

      let successMessage = "Item cancelled successfully.";
      if (refundAmount > 0) {
        successMessage = `Item cancelled. ₹${refundAmount.toLocaleString("en-IN")} refunded to your wallet.`;
      }

      return res.json({
        success: true,
        message: successMessage,
        refundAmount,
        orderStatus: order.orderStatus,
      });
    }

    if (!trimmedReason)
      return res.json({
        success: false,
        message: "Please provide a cancellation reason",
      });

    if (trimmedReason.length < 6)
      return res.json({
        success: false,
        message: "Please enter a reason with least 6 characters.",
      });

    if (!["confirmed", "shipped", "partially_cancelled"].includes(order.orderStatus)) {
      return res.json({
        success: false,
        message: `Order cannot be cancelled at this stage (${order.orderStatus})`,
      });
    }

    const activeItems = order.items.filter(
      (item) => !["cancelled", "returned"].includes(item.status),
    );
    
    const cancellableItems = activeItems.filter(
      (item) => ["confirmed", "shipped"].includes(getEffectiveStatus(item, order.orderStatus)),
    );

    if (cancellableItems.length === 0) {
      return res.json({
        success: false,
        message: "No cancellable items found in this order.",
      });
    }

    const eligibility = await validatePartialCancellation(order, cancellableItems);
    if (!eligibility.allowed) {
      return res.json({
        success: false,
        message: "cancel not allowed it is coupon value",
      });
    }

    const shouldRestoreStock = order.paymentMethod === "cod" || ["paid", "partially_refunded", "refunded", "adjusted"].includes(order.paymentStatus);

    cancellableItems.forEach((item) => {
      item.status = "cancelled";
      item.cancelReason = trimmedReason;
      item.cancelledAt = new Date();
    });

    const refundAmount = await refundItemsToWallet(
      order,
      cancellableItems,
      `Refund for cancelled items in order #${order.orderId}`,
    );

    if (shouldRestoreStock) {
      await Promise.all(
        cancellableItems.map((item) =>
          Variant.findByIdAndUpdate(item.variantId, {
            $inc: { stock: item.quantity },
          }),
        ),
      );
    }

    recalculateOrderStatus(order);
    if (order.orderStatus === "cancelled") {
      order.cancelReason = trimmedReason;
      order.cancelledAt = new Date();
      await releaseCouponUsage(order);
    }
    await order.save();

    return res.json({
      success: true,
      message:
        refundAmount > 0
          ? `Order cancelled. ₹${refundAmount.toLocaleString("en-IN")} refunded to your wallet.`
          : "Order cancelled successfully.",
      refundAmount,
      orderStatus: order.orderStatus,
    });
  } catch (error) {
    console.error("cancelOrder error:", error);
    res.status(500).json({ success: false, message: "Failed to cancel order" });
  }
};

export const requestReturn = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const { orderId } = req.params;
    const { reason, itemId } = req.body;
    
    if (!reason?.trim()) {
      return res.json({
        success: false,
        message: "Please provide a return reason",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(orderId))
      return res.json({ success: false, message: "Invalid order ID" });

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) return res.json({ success: false, message: "Order not found" });

    const now = new Date();

    if (itemId) {
      const item = order.items.find((item) => item._id.toString() === itemId);
      if (!item)
        return res.json({ success: false, message: "Item not found in order" });

      if (["returned", "return_requested"].includes(item.status))
        return res.json({
          success: false,
          message:
            item.status === "return_requested"
              ? "Return request already submitted — awaiting admin approval"
              : "Item already returned",
        });

      const effectiveItemStatus = getEffectiveStatus(item, order.orderStatus);

      if (effectiveItemStatus !== "delivered")
        return res.json({
          success: false,
          message: "Only delivered items can be returned",
        });

      const eligibility = await validatePartialCancellation(order, [item]);
      if (!eligibility.allowed) {
        return res.json({
          success: false,
          message:
            "Partial return is not allowed because coupon eligibility will be lost. Your remaining order value will fall below the coupon minimum purchase requirement.",
          maxCancellableAmount: eligibility.maxCancellableAmount,
          remainingSubtotal: eligibility.remainingSubtotal,
          minPurchaseAmount: eligibility.minPurchaseAmount,
        });
      }

      // Mark as pending admin approval — no refund yet
      item.status = "return_requested";
      item.returnReason = reason.trim();
      item.returnRequestedAt = now;
      item.returnRejectedAt = null;
      item.returnRejectionReason = null;

      // Update order-level status if all active items are return_requested
      const allPending = order.items
        .filter((item) => !["cancelled"].includes(item.status))
        .every((item) => item.status === "return_requested");
      if (allPending) order.orderStatus = "return_requested";

      await order.save();

      return res.json({
        success: true,
        message: "Return request submitted. Awaiting admin approval.",
        orderStatus: order.orderStatus,
      });
    }

    return res.json({
      success: false,
      message: "Please specify an item to return.",
    });
  } catch (error) {
    console.error("requestReturn error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to submit return" });
  }
};
