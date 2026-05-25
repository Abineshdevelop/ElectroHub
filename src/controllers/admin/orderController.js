import Order from "../../model/orderModel.js";
import { deriveOrderStatusFromItems } from "../../services/salesRevenueService.js";
import mongoose from "mongoose";
import { buildItemCancellationSafety, validatePartialCancellation } from "../../services/cancellationEligibilityService.js";
import { refundItemsToWallet } from "../../services/orderRefundService.js";

const FORWARD_TRANSITIONS = {
  pending:             ['confirmed', 'shipped', 'out_for_delivery', 'delivered'],
  confirmed:           ['shipped', 'out_for_delivery', 'delivered'],
  shipped:             ['out_for_delivery', 'delivered'],
  out_for_delivery:    ['delivered'],
  delivered:           ['return_requested', 'returned'],
  return_requested:    ['returned'],
  partially_cancelled: ['cancelled'],
  cancelled:           [],
  returned:            [],
  expired:             [],
};

export const getOrders = async (req, res) => {
  try {
    const { q = '', sort = 'desc', status = 'all', page = 1, ajax } = req.query;
    console.log(status)
    const limit       = 8;
    const currentPage = Math.max(1, Number(page));
    const skip        = (currentPage - 1) * limit;

    const filter = {};
if (status !== 'all') {

  const itemLevelStatuses = [
    'return_requested',
    'returned',
    'cancelled'
  ];

  if (itemLevelStatuses.includes(status)) {
    filter['items.status'] = status;
  } else {
    filter.orderStatus = status;
  }
} 
   if (q.trim()) {
      filter.$or = [
        { orderId:                     { $regex: q.trim(), $options: 'i' } },
            { 'shippingAddress.lastName':  { $regex: q.trim(), $options: 'i' } },
        { 'shippingAddress.email':     { $regex: q.trim(), $options: 'i' } },
      ];
    }

    const sortOrder = sort === 'asc' ? 1 : -1;
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: sortOrder }).skip(skip).limit(limit).lean(),
      Order.countDocuments(filter),
    ]);

    const totalPages  = Math.max(1, Math.ceil(total / limit));
    const showingFrom = total === 0 ? 0 : skip + 1;
    const showingTo   = Math.min(skip + limit, total);

    if (ajax === '1') {
      return res.json({ success: true, orders, total, currentPage, totalPages, showingFrom, showingTo });
    }

    res.render('admin/orders', {
      orders, total, currentPage, totalPages, showingFrom, showingTo,
      query: q, sort, statusFilter: status,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const getOrderDetail = async (req, res) => {
  try {
    const { id }  = req.params;
    const { ajax } = req.query;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      if (ajax === '1') return res.json({ success: false, message: 'Invalid ID' });
      return res.redirect('/admin/orders');
    }

    const order = await Order.findById(id)
      .populate("items.productId")
      .populate("items.variantId")
      .lean();
    if (!order) {
      if (ajax === '1') return res.json({ success: false, message: 'Order not found' });
      return res.redirect('/admin/orders');
    }

    const itemCancellationSafety = await buildItemCancellationSafety(order);

    if (ajax === '1') return res.json({ success: true, order, itemCancellationSafety });

    res.render('admin/orders', { order, itemCancellationSafety });
  } catch (err) {
    console.error(err);
    if (req.query.ajax === '1') return res.status(500).json({ success: false, message: 'Server error' });
    res.redirect('/admin/orders');
  }
};

export const updateItemStatus = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const { status }     = req.body;
    const allowed = ['pending','confirmed','shipped','out_for_delivery','delivered','cancelled','returned'];

    if (!allowed.includes(status))
      return res.json({ success: false, message: 'Invalid status' });

    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(itemId))
      return res.json({ success: false, message: 'Invalid ID' });

    const order = await Order.findById(id);
    if (!order) return res.json({ success: false, message: 'Order not found' });

    const item = order.items.find(i => i._id.toString() === itemId);
    if (!item) return res.json({ success: false, message: 'Item not found' });

    const currentItemStatus = item.status || order.orderStatus;

    if (status === currentItemStatus)
      return res.json({ success: true, message: 'Status is already set to ' + status });

    const validItemNext = FORWARD_TRANSITIONS[currentItemStatus] || [];
    if (!validItemNext.includes(status))
      return res.json({ success: false, message: `Cannot move item status from "${currentItemStatus}" to "${status}". Only forward transitions are allowed.` });

    const oldStatus = item.status;

    if (['cancelled', 'returned'].includes(status) && !['cancelled', 'returned'].includes(oldStatus)) {
      const eligibility = await validatePartialCancellation(order, [item]);
      if (!eligibility.allowed) {
        return res.json({
          success: false,
          message: status === 'returned'
            ? "Partial return is not allowed because coupon eligibility will be lost. The remaining order value will fall below the coupon minimum purchase requirement."
            : eligibility.message,
          maxCancellableAmount: eligibility.maxCancellableAmount,
          remainingSubtotal: eligibility.remainingSubtotal,
          minPurchaseAmount: eligibility.minPurchaseAmount,
        });
      }
    }

    item.status     = status;

    if (['cancelled', 'returned'].includes(status) && !['cancelled', 'returned'].includes(oldStatus)) {
      const Variant = (await import("../../model/variantModel.js")).default;
      const shouldRestoreStock = order.paymentMethod === 'cod' || ['paid', 'partially_refunded', 'refunded', 'adjusted'].includes(order.paymentStatus);

      if (shouldRestoreStock) {
        await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
      }

      await refundItemsToWallet(
        order,
        [item],
        `Refund for admin ${status} item "${item.productName}" in order #${order.orderId}`,
      );
    }

    order.items.forEach(i => {
      if (i.finalAmount == null) i.finalAmount = i.lineTotal ?? 0;
    });

    order.orderStatus = deriveOrderStatusFromItems(order.items);
    if (
      order.orderStatus === "delivered" &&
      !["paid", "partially_refunded", "refunded"].includes(order.paymentStatus)
    ) {
      order.paymentStatus = "paid";
    }

    await order.save();
    res.json({ success: true, itemStatus: item.status, orderStatus: order.orderStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const deleteOrder = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.json({ success: false, message: 'Invalid ID' });

    const order = await Order.findByIdAndDelete(id);
    if (!order) return res.json({ success: false, message: 'Order not found' });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PATCH /admin/orders/:id/return/approve
export const approveReturn = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.json({ success: false, message: 'Invalid order ID' });

    const order = await Order.findById(id);
    if (!order) return res.json({ success: false, message: 'Order not found' });

    const returnItems = order.items.filter(i => i.status === 'return_requested');
    if (returnItems.length === 0)
      return res.json({ success: false, message: 'No pending return requests found' });

    const now = new Date();
    const Variant = (await import('../../model/variantModel.js')).default;

    const eligibility = await validatePartialCancellation(order, returnItems);
    if (!eligibility.allowed) {
      return res.json({
        success: false,
        message:
          "Return cannot be approved because coupon eligibility will be lost. The remaining order value will fall below the coupon minimum purchase requirement.",
        maxCancellableAmount: eligibility.maxCancellableAmount,
        remainingSubtotal: eligibility.remainingSubtotal,
        minPurchaseAmount: eligibility.minPurchaseAmount,
      });
    }

    for (const item of returnItems) {
      item.status           = 'returned';
      item.returnApprovedAt = now;

      // Restore stock
      await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
    }

    const refundedAmount = await refundItemsToWallet(
      order,
      returnItems,
      `Refund for approved return on order #${order.orderId}`,
    );

    // Recalculate order-level status
    const statuses = order.items.map(i => i.status);
    const allDone  = statuses.every(s => ['returned', 'cancelled'].includes(s));
    if (allDone) {
      order.orderStatus = 'returned';
    } else {
      const anyActive = statuses.some(s => !['returned', 'cancelled'].includes(s));
      order.orderStatus = anyActive ? order.orderStatus : 'returned';
    }

    await order.save();
    const message = refundedAmount > 0
      ? 'Return approved. Refund issued to customer wallet.'
      : 'Return approved.';
    res.json({ success: true, message, orderStatus: order.orderStatus });
  } catch (err) {
    console.error('approveReturn error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// PATCH /admin/orders/:id/return/reject
export const rejectReturn = async (req, res) => {
  try {
    const { id }    = req.params;
    const { reason } = req.body;

    if (!reason?.trim())
      return res.json({ success: false, message: 'Please provide a rejection reason' });

    if (!mongoose.Types.ObjectId.isValid(id))
      return res.json({ success: false, message: 'Invalid order ID' });

    const order = await Order.findById(id);
    if (!order) return res.json({ success: false, message: 'Order not found' });

    const returnItems = order.items.filter(i => i.status === 'return_requested');
    if (returnItems.length === 0)
      return res.json({ success: false, message: 'No pending return requests found' });

    const now = new Date();

    for (const item of returnItems) {
      item.status                = 'return_rejected';
      item.returnRejectedAt      = now;
      item.returnRejectionReason = reason.trim();
    }

    // Update order status — if EVERY item is now terminal (delivered, cancelled, or rejected), 
    // we determine the most appropriate order-level status.
    const statuses = order.items.map(i => i.status);
    const hasActive = statuses.some(s => !['cancelled', 'returned', 'return_rejected', 'delivered'].includes(s));
    
    if (!hasActive) {
        const allRejected = statuses.every(s => s === 'return_rejected' || s === 'cancelled');
        if (allRejected) {
            order.orderStatus = 'return_rejected';
        } else {
            order.orderStatus = 'delivered';
        }
    }

    await order.save();
    res.json({ success: true, message: 'Return request rejected.', orderStatus: order.orderStatus });
  } catch (err) {
    console.error('rejectReturn error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
