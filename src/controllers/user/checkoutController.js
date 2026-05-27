import Order from "../../model/orderModel.js";
import Cart from "../../model/cartModel.js";
import Product from "../../model/productModel.js";
import Address from "../../model/addressModel.js";
import Coupon from "../../model/couponModel.js";
import Variant from "../../model/variantModel.js";
import Offer from "../../model/offersModel.js";
import Razorpay from "razorpay";
import crypto from "crypto";
import { getOrCreateWallet, debitWallet } from "./walletController.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

function calculateCouponDiscount(coupon, subtotal) {
  let discount = 0;
  if (coupon.discountType === "percentage") {
    discount = (subtotal * coupon.discountValue) / 100;
    if (coupon.maxDiscountAmount) {
      discount = Math.min(discount, coupon.maxDiscountAmount);
    }
  } else {
    discount = Math.min(coupon.discountValue, subtotal);
  }
  return Math.round(discount);
}

export const getCheckoutPage = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const cart = await Cart.findOne({ userId });

    if (!cart || cart.items.length === 0) {
      return res.redirect("/user/cart");
    }

    const cartItems = await getCartItems(cart);

    // Redirect if any cart item is unavailable or out of stock
    const unavailableItems = [];
    for (const item of cartItems) {
      if (!item.product?.isActive || item.product?.isDeleted) {
        unavailableItems.push(item);
      } else if (item.variant?.isDeleted || item.variant?.isActive === false) {
        unavailableItems.push(item);
      } else if (item.variant.stock < item.quantity) {
        unavailableItems.push(item);
      }
    }
    if (unavailableItems.length > 0) {
      return res.redirect("/user/cart");
    }

    const subtotal = cartItems.reduce((total, item) => total + item.lineTotal, 0);

    let discount = 0;
    if (req.session.appliedCoupon) {
      const coupon = await Coupon.findOne({
        code: req.session.appliedCoupon,
        status: "active",
        isDeleted: false,
      });

      const isCouponExpired = !coupon || coupon.endDate < new Date();
      const isBelowMinimum = coupon && coupon.minPurchaseAmount && subtotal < coupon.minPurchaseAmount;

      if (isCouponExpired || isBelowMinimum) {
        delete req.session.appliedCoupon;
        delete req.session.couponId;
        delete req.session.couponDiscount;
      } else {
        discount = calculateCouponDiscount(coupon, subtotal);
        req.session.couponDiscount = discount;
      }
    }

    const addresses = await Address.find({ userId }).sort({ isDefault: -1, createdAt: -1 });
    const wallet = await getOrCreateWallet(userId);

    res.render("user/cart/checkout", {
      user: req.session.user,
      cartItems,
      addresses,
      wallet,
      subtotal,
      shipping: 0,
      discount,
      total: subtotal - discount,
      appliedCoupon: req.session.appliedCoupon || null,
    });
  } catch (error) {
    console.error("getCheckoutPage error:", error);
    res.status(500).render("error", { message: "Failed to load checkout" });
  }
};

export const saveAddress = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const { firstName, lastName, phone, email, address, street, state, country, pincode } = req.body;

    if (!firstName || !lastName || !phone || !email || !address || !street || !state || !country || !pincode) {
      return res.json({ success: false, message: "All fields are required" });
    }

    if (!/^\d{6}$/.test(pincode.trim())) {
      return res.json({ success: false, message: "Pincode must be 6 digits" });
    }

    if (!/^\d{10}$/.test(phone.replace(/\D/g, ""))) {
      return res.json({ success: false, message: "Phone must be 10 digits" });
    }

    const newAddress = await Address.create({
      userId,
      firstName: firstName.trim(),
      lastName:  lastName.trim(),
      phone:     phone.trim(),
      email:     email.trim().toLowerCase(),
      address:   address.trim(),
      street:    street.trim(),
      state:     state.trim(),
      country:   country.trim(),
      pincode:   pincode.trim(),
      isDefault: false,
    });

    return res.json({ success: true, message: "Address saved", address: newAddress });
  } catch (error) {
    console.error("saveAddress error:", error);
    res.status(500).json({ success: false, message: "Failed to save address" });
  }
};

export const applyCoupon = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const { couponCode } = req.body;

    if (!couponCode?.trim()) {
      return res.json({ success: false, message: "Please enter a coupon code" });
    }

    const now = new Date();
    const coupon = await Coupon.findOne({
      code:      couponCode.trim().toUpperCase(),
      status:    "active",
      isDeleted: false,
      startDate: { $lte: now },
      endDate:   { $gte: now },
    });

    if (!coupon) {
      return res.json({ success: false, message: "Invalid or expired coupon" });
    }

    const alreadyUsed = coupon.usedBy.some((id) => id.toString() === userId.toString());
    if (alreadyUsed) {
      return res.json({ success: false, warning: true, message: "You have already used this coupon" });
    }

    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return res.json({ success: false, message: "Cart not found" });
    }

    if (coupon.usageLimit > 0 && coupon.usageCount >= coupon.usageLimit) {
      return res.json({ success: false, message: "Coupon usage limit reached" });
    }

    const cartItems = await getCartItems(cart);
    const hasCategoryRestriction = coupon.eligibleCategories && coupon.eligibleCategories.length > 0;
    const hasProductRestriction  = coupon.eligibleProducts   && coupon.eligibleProducts.length   > 0;

    let eligibleSubtotal = 0;
    for (const item of cartItems) {
      let isEligible = true;
      if (hasCategoryRestriction) {
        isEligible = coupon.eligibleCategories.some(
          (categoryId) => categoryId.toString() === item.product.categoryId.toString()
        );
      }
      if (hasProductRestriction && isEligible) {
        isEligible = coupon.eligibleProducts.some(
          (productId) => productId.toString() === item.productId.toString()
        );
      }
      if (isEligible) {
        eligibleSubtotal += item.lineTotal;
      }
    }

    if (eligibleSubtotal === 0) {
      return res.json({ success: false, message: "Coupon is not applicable for the items in your cart" });
    }

    if (coupon.minPurchaseAmount && eligibleSubtotal < coupon.minPurchaseAmount) {
      return res.json({
        success: false,
        message: `Minimum order ₹${coupon.minPurchaseAmount} required for this coupon`,
      });
    }

    const discount = calculateCouponDiscount(coupon, eligibleSubtotal);

    req.session.appliedCoupon  = coupon.code;
    req.session.couponId       = coupon._id;
    req.session.couponDiscount = discount;

    const cartTotal = cartItems.reduce((total, item) => total + item.lineTotal, 0);

    return res.json({
      success:  true,
      message:  `Coupon applied! You saved ₹${discount}`,
      discount,
      newTotal: cartTotal - discount,
    });
  } catch (error) {
    console.error("applyCoupon error:", error);
    res.status(500).json({ success: false, message: "Failed to apply coupon" });
  }
};

export const removeCoupon = async (req, res) => {
  try {
    delete req.session.appliedCoupon;
    delete req.session.couponId;
    delete req.session.couponDiscount;
    return res.json({ success: true, message: "Coupon removed" });
  } catch (error) {
    console.error("removeCoupon error:", error);
    res.status(500).json({ success: false, message: "Failed to remove coupon" });
  }
};

export const getAvailableCoupons = async (req, res) => {
  try {
    const now = new Date();
    const coupons = await Coupon.find({
      status:    "active",
      isDeleted: false,
      startDate: { $lte: now },
      endDate:   { $gte: now },
    }).select("code discountType discountValue minPurchaseAmount maxDiscountAmount endDate");

    return res.json({ success: true, coupons });
  } catch (error) {
    console.error("getAvailableCoupons error:", error);
    res.status(500).json({ success: false, message: "Failed to load coupons" });
  }
};

export const placeOrder = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const { addressId, paymentMethod } = req.body;

    if (!addressId) {
      return res.json({ success: false, message: "Please select a delivery address" });
    }
    if (!["wallet", "razorpay", "cod"].includes(paymentMethod)) {
      return res.json({ success: false, message: "Invalid payment method" });
    }

    const selectedAddress = await Address.findOne({ _id: addressId, userId });
    if (!selectedAddress) {
      return res.json({ success: false, message: "Address not found" });
    }

    const cart = await Cart.findOne({ userId });
    if (!cart || cart.items.length === 0) {
      return res.json({ success: false, message: "Your cart is empty" });
    }

    const cartItems = await getCartItems(cart);

    for (const item of cartItems) {
      if (!item.product?.isActive || item.product?.isDeleted) {
        return res.json({
          success: false,
          message: `"${item.product?.name}" is no longer available`,
        });
      }
    }

    const stockCheck = await checkStock(cartItems);
    if (!stockCheck.ok) {
      return res.json({ success: false, message: "Stock is not available" });
    }

    const subtotal = cartItems.reduce((total, item) => total + item.lineTotal, 0);

    // Validate and compute coupon discount
    let couponDiscount = 0;
    let couponSnapshot = null;

    if (req.session.appliedCoupon) {
      const coupon = await Coupon.findOne({
        code:      req.session.appliedCoupon,
        status:    "active",
        isDeleted: false,
      });

      const isCouponInvalid = !coupon || coupon.endDate < new Date();

      let eligibleSubtotal = 0;
      if (coupon) {
        const hasCategoryRestriction = coupon.eligibleCategories && coupon.eligibleCategories.length > 0;
        const hasProductRestriction  = coupon.eligibleProducts   && coupon.eligibleProducts.length   > 0;

        for (const item of cartItems) {
          let isEligible = true;
          if (hasCategoryRestriction) {
            isEligible = coupon.eligibleCategories.some(
              (categoryId) => categoryId.toString() === item.product.categoryId.toString()
            );
          }
          if (hasProductRestriction && isEligible) {
            isEligible = coupon.eligibleProducts.some(
              (productId) => productId.toString() === item.productId.toString()
            );
          }
          if (isEligible) eligibleSubtotal += item.lineTotal;
        }
      }

      const isBelowMinimum = coupon && coupon.minPurchaseAmount && eligibleSubtotal < coupon.minPurchaseAmount;
      const isLimitReached = coupon && coupon.usageLimit > 0 && coupon.usageCount >= coupon.usageLimit;

      if (isCouponInvalid || isBelowMinimum || isLimitReached) {
        delete req.session.appliedCoupon;
        delete req.session.couponId;
        delete req.session.couponDiscount;
        return res.json({
          success: false,
          message: "Applied coupon is no longer valid or eligible for your cart",
        });
      }

      couponDiscount = calculateCouponDiscount(coupon, eligibleSubtotal);
      couponSnapshot = {
        code:              coupon.code,
        discountType:      coupon.discountType,
        discountValue:     coupon.discountValue,
        minPurchaseAmount: coupon.minPurchaseAmount,
        maxDiscountAmount: coupon.maxDiscountAmount,
      };
    }

    const total      = Math.max(subtotal - couponDiscount, 0);
    const orderItems = buildOrderItems(cartItems, subtotal, couponDiscount);

    // ── COD ─────────────────────────────────────────────────────────────────
    if (paymentMethod === "cod") {
      const stockResult = await deductStock(cartItems);
      if (!stockResult.success) {
        return res.json({ success: false, message: "Stock is not available" });
      }

      const order = await Order.create({
        userId,
        items:           orderItems.map((item) => ({ ...item, status: "confirmed" })),
        shippingAddress: formatAddress(selectedAddress),
        couponCode:      req.session.appliedCoupon || null,
        couponId:        req.session.couponId       || null,
        couponSnapshot,
        subtotal,
        discount:        couponDiscount,
        couponDiscount,
        shipping:        0,
        totalAmount:     total,
        paidAmount:      total,
        paymentMethod:   "cod",
        paymentStatus:   "pending",
        orderStatus:     "confirmed",
      });

      if (req.session.couponId) {
        await Coupon.findByIdAndUpdate(req.session.couponId, {
          $addToSet: { usedBy: userId },
          $inc:      { usageCount: 1 },
        });
      }

      await Cart.findOneAndUpdate({ userId }, { $set: { items: [] } });
      delete req.session.appliedCoupon;
      delete req.session.couponId;
      delete req.session.couponDiscount;

      return res.json({
        success:     true,
        message:     "Order placed successfully!",
        orderId:     order._id,
        redirectUrl: `/user/checkout/success?orderId=${order._id}`,
      });
    }

    // ── Wallet ───────────────────────────────────────────────────────────────
    if (paymentMethod === "wallet") {
      const wallet = await getOrCreateWallet(userId);
      if (wallet.balance < total) {
        return res.json({
          success: false,
          message: `Insufficient wallet balance. Available: ₹${wallet.balance}`,
        });
      }

      const stockResult = await deductStock(cartItems);
      if (!stockResult.success) {
        return res.json({ success: false, message: "Stock is not available" });
      }

      const order = await Order.create({
        userId,
        items:           orderItems.map((item) => ({ ...item, status: "confirmed" })),
        shippingAddress: formatAddress(selectedAddress),
        couponCode:      req.session.appliedCoupon || null,
        couponId:        req.session.couponId       || null,
        couponSnapshot,
        subtotal,
        discount:        couponDiscount,
        couponDiscount,
        shipping:        0,
        totalAmount:     total,
        paidAmount:      total,
        paymentMethod:   "wallet",
        paymentStatus:   "paid",
        orderStatus:     "confirmed",
      });

      await debitWallet(userId, total, `Payment for order #${order.orderId}`, "order_payment", order._id);

      if (req.session.couponId) {
        await Coupon.findByIdAndUpdate(req.session.couponId, {
          $addToSet: { usedBy: userId },
          $inc:      { usageCount: 1 },
        });
      }

      await Cart.findOneAndUpdate({ userId }, { $set: { items: [] } });
      delete req.session.appliedCoupon;
      delete req.session.couponId;
      delete req.session.couponDiscount;

      return res.json({
        success:     true,
        message:     "Order placed successfully!",
        orderId:     order._id,
        redirectUrl: `/user/checkout/success?orderId=${order._id}`,
      });
    }

    // ── Razorpay ─────────────────────────────────────────────────────────────
    if (total < 1) {
      return res.json({ success: false, message: "Order total is too low for online payment" });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount:   Math.round(total * 100),
      currency: "INR",
      receipt:  `rcpt_${String(userId).slice(-8)}_${Date.now().toString().slice(-8)}`,
    });

    const order = await Order.create({
      userId,
      items:           orderItems,
      shippingAddress: formatAddress(selectedAddress),
      couponCode:      req.session.appliedCoupon || null,
      couponId:        req.session.couponId       || null,
      couponSnapshot,
      subtotal,
      discount:        couponDiscount,
      couponDiscount,
      shipping:        0,
      totalAmount:     total,
      paidAmount:      total,
      paymentMethod:   "razorpay",
      paymentStatus:   "pending",
      orderStatus:     "pending",
      razorpayOrderId: razorpayOrder.id,
      paymentAttempts: [{ razorpayOrderId: razorpayOrder.id, status: "created" }],
    });

    await Cart.findOneAndUpdate({ userId }, { $set: { items: [] } });
    delete req.session.appliedCoupon;
    delete req.session.couponId;
    delete req.session.couponDiscount;

    return res.json({
      success:         true,
      paymentRequired: true,
      dbOrderId:       order._id,
      orderId:         razorpayOrder.id,
      amount:          Math.round(total * 100),
      currency:        "INR",
      keyId:           process.env.RAZORPAY_KEY_ID,
      user: {
        name:  `${selectedAddress.firstName} ${selectedAddress.lastName}`,
        email: selectedAddress.email,
        phone: selectedAddress.phone,
      },
    });
  } catch (error) {
    console.error("placeOrder error:", error);
    res.status(500).json({ success: false, message: "Failed to place order. Please try again." });
  }
};

export const verifyPayment = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const { razorpayPaymentId, razorpayOrderId, razorpaySignature, dbOrderId } = req.body;

    if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      return res.json({ success: false, message: "Payment data is missing" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (expectedSignature !== razorpaySignature) {
      return res.json({ success: false, message: "Payment verification failed" });
    }

    const order = await Order.findOne({ _id: dbOrderId, userId });
    if (!order) {
      return res.json({ success: false, message: "Order not found" });
    }

    if (order.paymentStatus === "paid") {
      return res.json({
        success:     true,
        message:     "Order already processed",
        redirectUrl: `/user/checkout/success?orderId=${dbOrderId}`,
      });
    }

    const stockResult = await deductStock(order.items);
    if (!stockResult.success) {
      order.paymentStatus = "failed";
      order.orderStatus   = "cancelled";
      order.items.forEach((item) => { item.status = "cancelled"; });
      order.cancelReason  = "Stock unavailable at time of fulfillment";
      await order.save();
      return res.json({
        success: false,
        message: "Items sold out. Our team will contact you for a refund.",
      });
    }

    const paymentAttempt = order.paymentAttempts.find((attempt) => attempt.razorpayOrderId === razorpayOrderId);
    if (paymentAttempt) {
      paymentAttempt.status            = "success";
      paymentAttempt.razorpayPaymentId = razorpayPaymentId;
      paymentAttempt.razorpaySignature = razorpaySignature;
    }

    order.paymentStatus       = "paid";
    order.orderStatus         = "confirmed";
    order.items.forEach((item) => { item.status = "confirmed"; });
    order.razorpayOrderId     = razorpayOrderId;
    order.razorpayPaymentId   = razorpayPaymentId;
    order.razorpaySignature   = razorpaySignature;
    await order.save();

    if (order.couponId) {
      await Coupon.findByIdAndUpdate(order.couponId, {
        $addToSet: { usedBy: userId },
        $inc:      { usageCount: 1 },
      });
    }

    return res.json({
      success:     true,
      message:     "Payment verified successfully!",
      redirectUrl: `/user/checkout/success?orderId=${dbOrderId}`,
    });
  } catch (error) {
    console.error("verifyPayment error:", error);
    res.status(500).json({ success: false, message: "Failed to verify payment" });
  }
};

export const handlePaymentFailure = async (req, res) => {
  try {
    const userId      = req.session.user._id;
    const { dbOrderId } = req.body;

    const order = await Order.findOne({ _id: dbOrderId, userId });
    if (!order) {
      return res.json({ success: false, message: "Order not found" });
    }

    if (order.paymentStatus === "paid") {
      return res.json({ success: false, message: "Order is already paid" });
    }

    order.paymentStatus = "failed";
    if (order.paymentAttempts.length > 0) {
      order.paymentAttempts[order.paymentAttempts.length - 1].status = "failed";
    }
    await order.save();

    return res.json({ success: true, message: "Payment failure recorded" });
  } catch (error) {
    console.error("handlePaymentFailure error:", error);
    res.status(500).json({ success: false, message: "Failed to handle payment failure" });
  }
};

export const retryPayment = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const { orderId, paymentMethod } = req.body;

    const order = await Order.findOne({ _id: orderId, userId });
    if (!order) {
      return res.json({ success: false, message: "Order not found" });
    }

    if (order.paymentStatus === "paid") {
      return res.json({ success: false, message: "Order is already paid" });
    }

    const stockCheck = await checkStock(order.items);
    if (!stockCheck.ok) {
      return res.json({ success: false, message: "Stock is not available" });
    }

    // Return wallet/total info without confirming payment method
    if (!paymentMethod) {
      const wallet = await getOrCreateWallet(userId);
      return res.json({
        success:       true,
        infoOnly:      true,
        walletBalance: wallet.balance,
        totalAmount:   order.totalAmount,
      });
    }

    // ── Wallet retry ─────────────────────────────────────────────────────────
    if (paymentMethod === "wallet") {
      const wallet = await getOrCreateWallet(userId);
      if (wallet.balance < order.totalAmount) {
        return res.json({ success: false, message: "Insufficient wallet balance" });
      }

      const stockResult = await deductStock(order.items);
      if (!stockResult.success) {
        return res.json({ success: false, message: "Stock is not available" });
      }

      await debitWallet(
        userId,
        order.totalAmount,
        `Payment for order #${order.orderId}`,
        "order_payment",
        order._id,
      );

      order.paymentStatus = "paid";
      order.orderStatus   = "confirmed";
      order.items.forEach((item) => { item.status = "confirmed"; });
      await order.save();

      return res.json({
        success:     true,
        message:     "Payment successful via wallet!",
        redirectUrl: `/user/checkout/success?orderId=${order._id}`,
      });
    }

    // ── Razorpay retry ───────────────────────────────────────────────────────
    const razorpayOrder = await razorpay.orders.create({
      amount:   Math.round(order.totalAmount * 100),
      currency: "INR",
      receipt:  `rcpt_${String(userId).slice(-8)}_${Date.now().toString().slice(-8)}`,
    });

    order.razorpayOrderId = razorpayOrder.id;
    order.paymentAttempts.push({ razorpayOrderId: razorpayOrder.id, status: "created" });
    await order.save();

    return res.json({
      success:         true,
      paymentRequired: true,
      dbOrderId:       order._id,
      orderId:         razorpayOrder.id,
      amount:          Math.round(order.totalAmount * 100),
      currency:        "INR",
      keyId:           process.env.RAZORPAY_KEY_ID,
      user: {
        name:  `${order.shippingAddress.firstName} ${order.shippingAddress.lastName}`,
        email: order.shippingAddress.email,
        phone: order.shippingAddress.phone,
      },
    });
  } catch (error) {
    console.error("retryPayment error:", error);
    res.status(500).json({ success: false, message: "Failed to retry payment" });
  }
};

export const renderPaymentSuccess = async (req, res) => {
  try {
    const { orderId } = req.query;
    let totalAmount   = 0;
    let order         = null;

    if (orderId) {
      order = await Order.findById(orderId)
        .populate("items.productId")
        .populate("items.variantId")
        .lean();
      if (order) totalAmount = order.totalAmount;
    }

    res.render("user/pages/payment-success", {
      user: req.session.user,
      amount: totalAmount,
      order,
    });
  } catch (error) {
    res.render("user/pages/payment-success", { user: req.session.user, amount: 0, order: null });
  }
};

export const renderPaymentFailed = async (req, res) => {
  try {
    const { orderId } = req.query;
    let order         = null;

    if (orderId) {
      order = await Order.findById(orderId)
        .populate("items.productId")
        .populate("items.variantId")
        .lean();
    }

    res.render("user/pages/payment-failed", { user: req.session.user, order });
  } catch (error) {
    console.error("renderPaymentFailed error:", error);
    res.render("user/pages/payment-failed", { user: req.session.user, order: null });
  }
};

// ── Private helpers ──────────────────────────────────────────────────────────

async function getActiveOffers() {
  const now = new Date();
  return await Offer.find({
    isActive:  true,
    isDeleted: false,
    startDate: { $lte: now },
    endDate:   { $gte: now },
  }).lean();
}

function findBestOffer(product, activeOffers) {
  let bestOffer = null;
  for (const offer of activeOffers) {
    const matchesProduct  = offer.offerType === "product"  && String(offer.refId) === String(product._id);
    const matchesCategory = offer.offerType === "category" && String(offer.refId) === String(product.categoryId);
    if (matchesProduct || matchesCategory) {
      if (!bestOffer || offer.offerPrecentage > bestOffer.offerPrecentage) {
        bestOffer = offer;
      }
    }
  }
  return bestOffer;
}

async function getCartItems(cart) {
  const activeOffers = await getActiveOffers();
  const enrichedItems = [];

  for (const cartItem of cart.items) {
    const product = await Product.findById(cartItem.productId)
      .select("productName images isActive isDeleted categoryId")
      .lean();

    const variant = await Variant.findById(cartItem.variantId)
      .select("price stock images options isActive isDeleted")
      .lean();

    if (!product || !variant) continue;

    const discountPercentage = findBestOffer(product, activeOffers)?.offerPrecentage ?? 0;
    const basePrice          = variant.price;
    const salePrice          = discountPercentage > 0
      ? Math.round(basePrice * (1 - discountPercentage / 100))
      : basePrice;

    enrichedItems.push({
      productId:     cartItem.productId,
      variantId:     cartItem.variantId,
      quantity:      cartItem.quantity,
      product:       { ...product, name: product.productName },
      variant,
      image:         variant.images?.[0] ?? product.images?.[0] ?? "",
      unitPrice:     salePrice,
      originalPrice: basePrice,
      offerPct:      discountPercentage,
      lineTotal:     salePrice * cartItem.quantity,
    });
  }

  return enrichedItems;
}

async function checkStock(items) {
  for (const item of items) {
    const variant = await Variant.findById(item.variantId);
    if (!variant || variant.isDeleted || variant.isActive === false || variant.stock < item.quantity) {
      return { ok: false, name: item.product?.name || "Unknown" };
    }
  }
  return { ok: true };
}

async function deductStock(items) {
  const deductedItems = [];
  for (const item of items) {
    const updatedVariant = await Variant.findOneAndUpdate(
      { _id: item.variantId, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity } },
      { returnDocument: "after" },
    );
    if (!updatedVariant) {
      // Rollback all previously deducted stock
      for (const deductedItem of deductedItems) {
        await Variant.findByIdAndUpdate(deductedItem.variantId, {
          $inc: { stock: deductedItem.quantity },
        });
      }
      return { success: false };
    }
    deductedItems.push(item);
  }
  return { success: true };
}

function formatAddress(address) {
  return {
    firstName:   address.firstName,
    lastName:    address.lastName,
    phone:       address.phone,
    email:       address.email,
    addressLine: address.address,
    street:      address.street,
    state:       address.state,
    country:     address.country,
    pincode:     address.pincode,
  };
}

function buildOrderItems(cartItems, subtotal, totalCouponDiscount) {
  const orderItems = cartItems.map((item) => {
    const couponShare = subtotal > 0
      ? Math.round((item.lineTotal / subtotal) * totalCouponDiscount)
      : 0;
    return {
      productId:         item.productId,
      variantId:         item.variantId,
      productName:       item.product.name,
      productImage:      item.image || "",
      variantAttributes: item.variant.options,
      quantity:          item.quantity,
      unitPrice:         item.unitPrice,
      originalPrice:     item.originalPrice || item.unitPrice,
      lineTotal:         item.lineTotal,
      couponDiscount:    couponShare,
      discountShare:     couponShare,
      finalAmount:       item.lineTotal - couponShare,
      finalPrice:        item.lineTotal - couponShare,
      paidAmount:        item.lineTotal - couponShare,
      status:            "pending",
    };
  });

  // Fix rounding errors when distributing coupon discount across items
  const distributedTotal = orderItems.reduce((sum, item) => sum + item.couponDiscount, 0);
  const roundingDiff     = totalCouponDiscount - distributedTotal;
  if (roundingDiff !== 0 && orderItems.length > 0) {
    const lastItem         = orderItems[orderItems.length - 1];
    lastItem.couponDiscount += roundingDiff;
    lastItem.discountShare  += roundingDiff;
    lastItem.finalAmount    -= roundingDiff;
    lastItem.finalPrice     -= roundingDiff;
    lastItem.paidAmount     -= roundingDiff;
  }

  return orderItems;
}
