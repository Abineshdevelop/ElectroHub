import Coupon from "../model/couponModel.js";

function toAmount(value) {
  return Math.max(0, Math.round(Number(value || 0)));
}

export function hasAppliedCoupon(order) {
  if (!order || order.couponStatus === "removed") return false;

  return Boolean(
    order?.couponId ||
      order?.couponCode ||
      toAmount(order?.discount) > 0,
  );
}

export function getCouponMinimumPurchase(order, coupon = null) {
  return toAmount(
    order?.couponSnapshot?.minPurchaseAmount ??
      coupon?.minPurchaseAmount ??
      0,
  );
}

export async function validateOrderCoupon(order) {
  if (!hasAppliedCoupon(order)) {
    return { valid: true, coupon: null, minPurchaseAmount: 0 };
  }

  const coupon = order.couponId ? await Coupon.findById(order.couponId) : null;
  const minPurchaseAmount = getCouponMinimumPurchase(order, coupon);

  if (order.couponId && !coupon) {
    return {
      valid: false,
      coupon,
      minPurchaseAmount,
      message: "Applied coupon is no longer available.",
    };
  }

  if (coupon?.isDeleted || coupon?.status !== "active") {
    return {
      valid: false,
      coupon,
      minPurchaseAmount,
      message: "Applied coupon is not active.",
    };
  }

  const now = new Date();
  if (coupon && (coupon.startDate > now || coupon.endDate < now)) {
    return {
      valid: false,
      coupon,
      minPurchaseAmount,
      message: "Applied coupon has expired.",
    };
  }

  if (
    coupon?.usageLimit > 0 &&
    coupon.usageCount >= coupon.usageLimit
  ) {
    return {
      valid: false,
      coupon,
      minPurchaseAmount,
      message: "Applied coupon usage limit has been exceeded.",
    };
  }

  return { valid: true, coupon, minPurchaseAmount };
}

export async function releaseCouponUsage(order) {
  if (!order?.couponId) return;

  await Coupon.findOneAndUpdate(
    { _id: order.couponId, usageCount: { $gt: 0 } },
    {
      $pull: { usedBy: order.userId },
      $inc: { usageCount: -1 },
    },
  );

  order.couponStatus = "removed";
}
