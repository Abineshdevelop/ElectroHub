import Order from "../../model/orderModel.js";
import mongoose from "mongoose";
import { creditWallet } from "../user/walletController.js";

const FORWARD_TRANSITIONS = {
  pending:             ['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'],
  confirmed:           ['processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'],
  processing:          ['shipped', 'out_for_delivery', 'delivered', 'cancelled'],
  shipped:             ['out_for_delivery', 'delivered', 'cancelled'],
  out_for_delivery:    ['delivered', 'cancelled'],
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
    const limit       = 8;
    const currentPage = Math.max(1, Number(page));
    const skip        = (currentPage - 1) * limit;

    const filter = {};
    if (status !== 'all') filter.orderStatus = status;
    if (q.trim()) {
      filter.$or = [
        { orderId:                     { $regex: q.trim(), $options: 'i' } },
        { 'shippingAddress.firstName': { $regex: q.trim(), $options: 'i' } },
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

    const order = await Order.findById(id).lean();
    if (!order) {
      if (ajax === '1') return res.json({ success: false, message: 'Order not found' });
      return res.redirect('/admin/orders');
    }

    if (ajax === '1') return res.json({ success: true, order });

    res.render('admin/orders', { order });
  } catch (err) {
    console.error(err);
    if (req.query.ajax === '1') return res.status(500).json({ success: false, message: 'Server error' });
    res.redirect('/admin/orders');
  }
};

export const updateOrderStatus = async (req, res) => {
  try {
    const { id }     = req.params;
    const { status } = req.body;
    const allowed    = ['pending','confirmed','processing','shipped','out_for_delivery','delivered','cancelled','returned'];

    if (!allowed.includes(status))
      return res.json({ success: false, message: 'Invalid status' });

    const order = await Order.findById(id);
    if (!order) return res.json({ success: false, message: 'Order not found' });

    if (status === order.orderStatus)
      return res.json({ success: true, orderStatus: order.orderStatus, message: 'Status is already set to ' + status });

    const validNext = FORWARD_TRANSITIONS[order.orderStatus] || [];
    if (!validNext.includes(status))
      return res.json({ success: false, message: `Cannot move status from "${order.orderStatus}" to "${status}". Only forward transitions are allowed.` });

    const oldStatus   = order.orderStatus;
    order.orderStatus = status;

    // If order is delivered, it should be considered paid (especially for COD)
    if (status === 'delivered' && order.paymentStatus !== 'refunded') {
      order.paymentStatus = 'paid';
    }

    if (['cancelled', 'returned'].includes(status) && !['cancelled', 'returned'].includes(oldStatus)) {
      if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded') {
        const Variant = (await import("../../model/variantModel.js")).default;
        for (const item of order.items) {
          if (!['cancelled', 'returned'].includes(item.status)) {
            await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });
          }
        }

        const alreadyRefunded = order.refundAmount || 0;
        const refundAmount    = Math.max(0, (order.totalAmount || 0) - alreadyRefunded);

        if (refundAmount > 0 && order.paymentStatus === 'paid') {
          order.refundAmount      = alreadyRefunded + refundAmount;
          order.refundStatus      = 'processed';
          order.refundProcessedAt = new Date();
          order.paymentStatus     = 'refunded';
          await creditWallet(order.userId, refundAmount, `Refund for Admin updated ${status} order #${order.orderId}`);
        }
      }
    }

    order.items.forEach(i => {
      if (!['cancelled', 'returned'].includes(i.status)) i.status = status;
    });

    await order.save();
    res.json({ success: true, orderStatus: order.orderStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

export const updateItemStatus = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const { status }     = req.body;
    const allowed = ['pending','confirmed','processing','shipped','out_for_delivery','delivered','cancelled','returned'];

    if (!allowed.includes(status))
      return res.json({ success: false, message: 'Invalid status' });

    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(itemId))
      return res.json({ success: false, message: 'Invalid ID' });

    const order = await Order.findById(id);
    if (!order) return res.json({ success: false, message: 'Order not found' });

    const item = order.items.find(i => i._id.toString() === itemId);
    if (!item) return res.json({ success: false, message: 'Item not found' });

    if (status === 'cancelled' && order.discount > 0)
      return res.json({ success: false, message: 'Cannot cancel individual items on a coupon/offer order. Cancel the entire order instead.' });

    const currentItemStatus = item.status || order.orderStatus;

    if (status === currentItemStatus)
      return res.json({ success: true, message: 'Status is already set to ' + status });

    const validItemNext = FORWARD_TRANSITIONS[currentItemStatus] || [];
    if (!validItemNext.includes(status))
      return res.json({ success: false, message: `Cannot move item status from "${currentItemStatus}" to "${status}". Only forward transitions are allowed.` });

    const oldStatus = item.status;
    item.status     = status;

    if (['cancelled', 'returned'].includes(status) && !['cancelled', 'returned'].includes(oldStatus)) {
      if (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded') {
        const Variant = (await import("../../model/variantModel.js")).default;
        await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });

        const rawRefund       = item.finalAmount != null ? item.finalAmount : Math.max(0, (item.lineTotal ?? 0) - (item.couponDiscount ?? 0));
        const alreadyRefunded = order.refundAmount || 0;
        const refundAmt       = Math.min(rawRefund, Math.max(0, (order.totalAmount || 0) - alreadyRefunded));

        if (refundAmt > 0 && order.paymentStatus === 'paid') {
          order.refundAmount      = alreadyRefunded + refundAmt;
          order.refundStatus      = 'processed';
          order.refundProcessedAt = new Date();
          await creditWallet(order.userId, refundAmt, `Refund for Admin updated ${status} item "${item.productName}" in order #${order.orderId}`);
        }
      }
    }

    order.items.forEach(i => {
      if (i.finalAmount == null) i.finalAmount = i.lineTotal ?? 0;
    });

    const statuses = order.items.map(i => i.status);
    const allSame  = statuses.every(s => s === statuses[0]);

    if (allSame) {
      order.orderStatus = statuses[0];
    } else {
      const allCancelled  = statuses.every(s => s === 'cancelled');
      const allDelivered  = statuses.every(s => s === 'delivered');
      const allDone       = statuses.every(s => ['returned', 'cancelled'].includes(s));
      const someCancelled = statuses.some(s => s === 'cancelled');

      if (allCancelled)       order.orderStatus = 'cancelled';
      else if (allDelivered)  {
        order.orderStatus = 'delivered';
        if (order.paymentStatus !== 'refunded') order.paymentStatus = 'paid';
      }
      else if (allDone)       order.orderStatus = 'returned';
      else if (someCancelled) order.orderStatus = 'partially_cancelled';
      else {
        const priority = ['out_for_delivery', 'shipped', 'processing', 'confirmed'];
        const active   = statuses.filter(s => !['cancelled', 'returned'].includes(s));
        order.orderStatus = priority.find(p => active.includes(p)) || active[0] || order.orderStatus;
      }
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

    let totalRefund = 0;

    for (const item of returnItems) {
      item.status           = 'returned';
      item.returnApprovedAt = now;

      // Restore stock
      await Variant.findByIdAndUpdate(item.variantId, { $inc: { stock: item.quantity } });

      // Accumulate refund amount
      const itemRefund = item.finalAmount != null
        ? item.finalAmount
        : Math.max(0, (item.lineTotal ?? 0) - (item.couponDiscount ?? 0));
      totalRefund += itemRefund;
    }

    // Issue wallet refund if order was paid (Online) or was COD and Delivered
    // We also check if it's currently 'pending' but delivered (common for COD)
    const isEligibleForRefund = 
      ['paid', 'refunded', 'partially_refunded'].includes(order.paymentStatus) ||
      (order.paymentMethod === 'cod' && ['delivered', 'return_requested', 'returned'].includes(order.orderStatus));
    
    if (totalRefund > 0 && isEligibleForRefund) {
      const alreadyRefunded = order.refundAmount || 0;
      // We should not refund more than what was actually paid
      const maxRefundable   = Math.max(0, (order.totalAmount || 0) - alreadyRefunded);
      const safeRefund      = Math.min(totalRefund, maxRefundable);

      if (safeRefund > 0) {
        order.refundAmount      = alreadyRefunded + safeRefund;
        order.refundStatus      = 'processed';
        order.refundProcessedAt = now;
        
        // If we have now refunded everything, it's 'refunded'; otherwise 'partially_refunded'
        const isFullyRefunded = order.refundAmount >= (order.totalAmount || 0);
        order.paymentStatus   = isFullyRefunded ? 'refunded' : 'partially_refunded';
        
        await creditWallet(order.userId, safeRefund, `Refund for approved return on order #${order.orderId}`, "order_refund", order._id);
      }
    }

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
    res.json({ success: true, message: 'Return approved. Refund issued to customer wallet.', orderStatus: order.orderStatus });
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