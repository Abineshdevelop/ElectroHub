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

const calculateCouponDiscount = (coupon, subtotal) => {
  let discount = 0;
  if (coupon.discountType === "percentage") {
    discount = (subtotal * coupon.discountValue) / 100;
    if (coupon.maxDiscountAmount) {
      discount = Math.min(discount, coupon.maxDiscountAmount);//min value of discount
    }
  } else {
    discount = Math.min(coupon.discountValue, subtotal);
  }
  return Math.round(discount);
};

export const getCheckoutPage = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const cart = await Cart.findOne({ userId });
    if (!cart || cart.items.length === 0) {
      return res.redirect("/user/cart");
    }
    const cartItems = await getCartItems(cart);
    const unavailable = [];//check any item is unavaiable that is added in cart

    for (const i of cartItems) {
      // check is active and quantity
      if (!i.product?.isActive || i.product?.isDeleted) {
        unavailable.push(i);
      } else if (i.variant?.isDeleted || i.variant?.isActive === false) {
        unavailable.push(i);
      } else if (i.variant.stock < i.quantity) {
        unavailable.push(i);
      }
    }
    if (unavailable.length > 0) {
      return res.redirect("/user/cart");
    }

    const subtotal = cartItems.reduce((sum, i) => sum + i.lineTotal, 0);

    let discount = 0;
    if (req.session.appliedCoupon) {
      const coupon = await Coupon.findOne({
        code: req.session.appliedCoupon,
        status: "active",
        isDeleted: false,
      });

      const isExpired = !coupon || coupon.endDate < new Date();
      const belowMinimum =
        coupon &&
        coupon.minPurchaseAmount &&
        subtotal < coupon.minPurchaseAmount;

      if (isExpired || belowMinimum) {
        delete req.session.appliedCoupon;
        delete req.session.couponId;
        delete req.session.couponDiscount;
      } else {
        discount = calculateCouponDiscount(coupon, subtotal);
        req.session.couponDiscount = discount;
      }
    }

    const addresses = await Address.find({ userId }).sort({
      isDefault: -1,
      createdAt: -1,
    });
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
  } catch (err) {
    console.error("getCheckoutPage error:", err);
    res.status(500).render("error", { message: "Failed to load checkout" });
  }
};

export const saveAddress = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const {
      firstName,
      lastName,
      phone,
      email,
      address,
      street,
      state,
      country,
      pincode,
    } = req.body;

    if (
      !firstName ||
      !lastName ||
      !phone ||
      !email ||
      !address ||
      !street ||
      !state ||
      !country ||
      !pincode
    ) {
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
      lastName: lastName.trim(),
      phone: phone.trim(),
      email: email.trim().toLowerCase(),
      address: address.trim(),
      street: street.trim(),
      state: state.trim(),
      country: country.trim(),
      pincode: pincode.trim(),
      isDefault: false,
    });

    return res.json({
      success: true,
      message: "Address saved",
      address: newAddress,
    });
  } catch (err) {
    console.error("saveAddress error:", err);
    res.status(500).json({ success: false, message: "Failed to save address" });
  }
};

export const applyCoupon = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const { couponCode } = req.body;

    if (!couponCode?.trim()) {
      return res.json({
        success: false,
        message: "Please enter a coupon code",
      });
    }

    const now = new Date();
    const coupon = await Coupon.findOne({
      code: couponCode.trim().toUpperCase(),
      status: "active",
      isDeleted: false,
      startDate: { $lte: now },
      endDate: { $gte: now },
    });

    if (!coupon) {
      return res.json({ success: false, message: "Invalid or expired coupon" });
    }

    const alreadyUsed = coupon.usedBy.some(
      (id) => id.toString() === userId.toString(),
    );

    if (alreadyUsed) {
      return res.json({
        success: false,
        warning: true,
        message: "You have already used this coupon",
      });
    }

    const cart = await Cart.findOne({ userId });
    if (!cart) {
      return res.json({ success: false, message: "Cart not found" });
    }

    if (coupon.usageLimit > 0 && coupon.usageCount >= coupon.usageLimit) {
      return res.json({ success: false, message: "Coupon usage limit reached" });
    }

    const cartItems = await getCartItems(cart);
    let subtotal = 0;

    // Check product/category eligibility
    const hasCategoryRestriction = coupon.eligibleCategories && coupon.eligibleCategories.length > 0;
    const hasProductRestriction = coupon.eligibleProducts && coupon.eligibleProducts.length > 0;

    cartItems.forEach(item => {
      let eligible = true;
      if (hasCategoryRestriction) {
        eligible = coupon.eligibleCategories.some(cId => cId.toString() === item.product.categoryId.toString());
      }
      if (hasProductRestriction && eligible) {
        eligible = coupon.eligibleProducts.some(pId => pId.toString() === item.productId.toString());
      }
      if (eligible) {
        subtotal += item.lineTotal;
      }
    });

    if (subtotal === 0) {
      return res.json({ success: false, message: "Coupon is not applicable for the items in your cart" });
    }

    if (coupon.minPurchaseAmount && subtotal < coupon.minPurchaseAmount) {
      return res.json({
        success: false,
        message: `Minimum order ₹${coupon.minPurchaseAmount} required for this coupon`,
      });
    }

    const discount = calculateCouponDiscount(coupon, subtotal);

    req.session.appliedCoupon = coupon.code;
    req.session.couponId = coupon._id;
    req.session.couponDiscount = discount;

    // Calculate total cart value to show accurate new total
    const cartTotal = cartItems.reduce((sum, i) => sum + i.lineTotal, 0);

    return res.json({
      success: true,
      message: `Coupon applied! You saved ₹${discount}`,
      discount,
      newTotal: cartTotal - discount,
    });
  } catch (err) {
    console.error("applyCoupon error:", err);
    res.status(500).json({ success: false, message: "Failed to apply coupon" });
  }
};

export const removeCoupon = async (req, res) => {
  try {
    delete req.session.appliedCoupon;
    delete req.session.couponId;
    delete req.session.couponDiscount;
    return res.json({ success: true, message: "Coupon removed" });
  } catch (err) {
    console.error("removeCoupon error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to remove coupon" });
  }
};

export const getAvailableCoupons = async (req, res) => {
  try {
    const now = new Date();
    const coupons = await Coupon.find({
      status: "active",
      isDeleted: false,
      startDate: { $lte: now },
      endDate: { $gte: now },
    }).select(
      "code discountType discountValue minPurchaseAmount maxDiscountAmount endDate",
    );

    const userId = req.session.user._id;

    return res.json({ success: true, coupons });
  } catch (err) {
    console.error("getAvailableCoupons error:", err);
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
      if (!item.product?.isActive || item.product?.isDeleted) { //in array
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

    const subtotal = cartItems.reduce((sum, i) => sum + i.lineTotal, 0);

    let couponDiscount = 0;
    let couponSnapshot = null;
    if (req.session.appliedCoupon) {
      const coupon = await Coupon.findOne({
        code: req.session.appliedCoupon,
        status: "active",
        isDeleted: false,
      });

      const isInvalid = !coupon || coupon.endDate < new Date();
      //whether the coupon is valid or not
      //which item is eligible for coupon
      //caculate totalsub for only eligible items
      let eligibleSubtotal = 0;
      if (coupon) {
        const hasCategoryRestriction = coupon.eligibleCategories && coupon.eligibleCategories.length > 0;
        const hasProductRestriction = coupon.eligibleProducts && coupon.eligibleProducts.length > 0;

        cartItems.forEach(item => {
          let eligible = true;
          if (hasCategoryRestriction) {
            eligible = coupon.eligibleCategories.some(cId => cId.toString() === item.product.categoryId.toString());
          }
          if (hasProductRestriction && eligible) {
            eligible = coupon.eligibleProducts.some(pId => pId.toString() === item.productId.toString());
          }
          if (eligible) {
            eligibleSubtotal += item.lineTotal;
          }
        });
      }

      const belowMinimum = coupon && coupon.minPurchaseAmount && eligibleSubtotal < coupon.minPurchaseAmount;

      const limitReached = coupon && coupon.usageLimit > 0 && coupon.usageCount >= coupon.usageLimit;

      if (isInvalid || belowMinimum || limitReached) {
        delete req.session.appliedCoupon;
        delete req.session.couponId;
        delete req.session.couponDiscount;
        return res.json({ success: false, message: "Applied coupon is no longer valid or eligible for your cart" });
      }

      couponDiscount = calculateCouponDiscount(coupon, eligibleSubtotal);

      couponSnapshot = {
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        minPurchaseAmount: coupon.minPurchaseAmount,
        maxDiscountAmount: coupon.maxDiscountAmount,
      };
    }

    const total = Math.max(subtotal - couponDiscount, 0);
    const orderItems = buildOrderItems(cartItems, subtotal, couponDiscount); //subtotal = total amount sum

    if (paymentMethod === "cod") {
      const stockResult = await deductStock(cartItems);
      if (!stockResult.success) {          //{success:false}. return 
        return res.json({ success: false, message: "Stock is not available" });
      }

      const order = await Order.create({
        userId,
        items: orderItems.map(i => ({ ...i, status: "confirmed" })),
        shippingAddress: formatAddress(selectedAddress),
        couponCode: req.session.appliedCoupon || null,
        couponId:   req.session.couponId   || null,
        couponSnapshot,
        subtotal,
        discount:      couponDiscount,
        couponDiscount,
        shipping:      0,
        totalAmount:   total,
        paidAmount:    total,
        paymentMethod: "cod",
        paymentStatus: "pending",
        orderStatus:   "confirmed",
      });

      if (req.session.couponId) {
        await Coupon.findByIdAndUpdate(req.session.couponId, {
          $addToSet: { usedBy: userId },
          $inc: { usageCount: 1 },
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

    //wallet
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
        items: orderItems.map(i => ({ ...i, status: "confirmed" })),
        shippingAddress: formatAddress(selectedAddress),
        couponCode: req.session.appliedCoupon || null,
        couponId:   req.session.couponId   || null,
        couponSnapshot,
        subtotal,
        discount:      couponDiscount,
        couponDiscount,
        shipping:      0,
        totalAmount:   total,
        paidAmount:    total,
        paymentMethod: "wallet",
        paymentStatus: "paid",
        orderStatus:   "confirmed",
      });

      await debitWallet(
        userId,
        total,
        `Payment for order #${order.orderId}`,
        "order_payment",
        order._id,
      );

      if (req.session.couponId) {
        await Coupon.findByIdAndUpdate(req.session.couponId, {
          $addToSet: { usedBy: userId },
          $inc: { usageCount: 1 },
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

    //razerpay

    if (total < 1) {
      return res.json({ success: false, message: "Order total is too low for online payment" });
    }

    const rzpOrder = await razorpay.orders.create({
      amount:   Math.round(total * 100),
      currency: "INR",
      receipt:  `rcpt_${String(userId).slice(-8)}_${Date.now().toString().slice(-8)}`,
    });

    const order = await Order.create({
      userId,
      items: orderItems,
      shippingAddress: formatAddress(selectedAddress),
      couponCode: req.session.appliedCoupon || null,
      couponId:   req.session.couponId   || null,
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
      razorpayOrderId: rzpOrder.id,
      paymentAttempts: [{ razorpayOrderId: rzpOrder.id, status: "created" }],
    });

    await Cart.findOneAndUpdate({ userId }, { $set: { items: [] } });
    delete req.session.appliedCoupon;
    delete req.session.couponId;
    delete req.session.couponDiscount;

    return res.json({
      success:         true,
      paymentRequired: true,
      dbOrderId:       order._id,
      orderId:         rzpOrder.id,
      amount:          Math.round(total * 100),
      currency:        "INR",
      keyId:           process.env.RAZORPAY_KEY_ID,
      user: {
        name:  `${selectedAddress.firstName} ${selectedAddress.lastName}`,
        email: selectedAddress.email,
        phone: selectedAddress.phone,
      },
    });
  } catch (err) {
    console.error("placeOrder error:", err);
    res.status(500).json({ success: false, message: "Failed to place order. Please try again." });
  }
};

export const verifyPayment = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const { razorpayPaymentId, razorpayOrderId, razorpaySignature, dbOrderId } =
      req.body;

    if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      return res.json({ success: false, message: "Payment data is missing" });
    }

    //recreate the signature 
    const expected = crypto//using hmac algorithem
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");//convert hash into hexa decimal string

    if (expected !== razorpaySignature) {
      return res.json({
        success: false,
        message: "Payment verification failed",
      });
    }

    const order = await Order.findOne({ _id: dbOrderId, userId });
    if (!order) {
      return res.json({ success: false, message: "Order not found" });
    }

    if (order.paymentStatus === "paid") {
      return res.json({
        success: true,
        message: "Order already processed",
        redirectUrl: `/user/checkout/success?orderId=${dbOrderId}`,
      });
    }

    const stockResult = await deductStock(order.items);
    if (!stockResult.success) {
      order.paymentStatus = "failed";
      order.orderStatus = "cancelled";
      order.items.forEach(i => i.status = "cancelled");
      order.cancelReason = "Stock unavailable at time of fulfillment";
      await order.save();
      return res.json({
        success: false,
        message: "Items sold out. Our team will contact you for a refund.",
      });
    }

    const attempt = order.paymentAttempts.find(
      (a) => a.razorpayOrderId === razorpayOrderId,
    );
    if (attempt) {
      attempt.status = "success";
      attempt.razorpayPaymentId = razorpayPaymentId;
      attempt.razorpaySignature = razorpaySignature;
    }

    order.paymentStatus = "paid";
    order.orderStatus = "confirmed";
    order.items.forEach(i => i.status = "confirmed");
    order.razorpayOrderId = razorpayOrderId;
    order.razorpayPaymentId = razorpayPaymentId;
    order.razorpaySignature = razorpaySignature;
    await order.save();

    if (order.couponId) {
      await Coupon.findByIdAndUpdate(order.couponId, {
        $addToSet: { usedBy: userId },
        $inc: { usageCount: 1 },
      });
    }

    return res.json({
      success: true,
      message: "Payment verified successfully!",
      redirectUrl: `/user/checkout/success?orderId=${dbOrderId}`,
    });
  } catch (err) {
    console.error("verifyPayment error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to verify payment" });
  }
};

export const handlePaymentFailure = async (req, res) => {
  try {
    const userId = req.session.user._id;
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
  } catch (err) {
    console.error("handlePaymentFailure error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to handle payment failure" });
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

    if (!paymentMethod) {
      const wallet = await getOrCreateWallet(userId);
      return res.json({
        success: true,
        infoOnly: true,
        walletBalance: wallet.balance,
        totalAmount: order.totalAmount,
      });
    }

    if (paymentMethod === "wallet") {
      const wallet = await getOrCreateWallet(userId);
      if (wallet.balance < order.totalAmount) {
        return res.json({
          success: false,
          message: "Insufficient wallet balance",
        });
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
      order.orderStatus = "confirmed";
      order.items.forEach(i => i.status = "confirmed");
      await order.save();

      return res.json({
        success: true,
        message: "Payment successful via wallet!",
        redirectUrl: `/user/checkout/success?orderId=${order._id}`,
      });
    }

    const rzpOrder = await razorpay.orders.create({
      amount: Math.round(order.totalAmount * 100),
      currency: "INR",
      receipt: `rcpt_${String(userId).slice(-8)}_${Date.now().toString().slice(-8)}`,
    });

    order.razorpayOrderId = rzpOrder.id;
    order.paymentAttempts.push({
      razorpayOrderId: rzpOrder.id,
      status: "created",
    });
    await order.save();

    return res.json({
      success: true,
      paymentRequired: true,
      dbOrderId: order._id,
      orderId: rzpOrder.id,
      amount: Math.round(order.totalAmount * 100),
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
      user: {
        name: `${order.shippingAddress.firstName} ${order.shippingAddress.lastName}`,
        email: order.shippingAddress.email,
        phone: order.shippingAddress.phone,
      },
    });
  } catch (err) {
    console.error("retryPayment error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to retry payment" });
  }
};

export const renderPaymentSuccess = async (req, res) => {
  try {
    const { orderId } = req.query;
    let amount = 0;
    let order = null;

    if (orderId) {
      order = await Order.findById(orderId)
        .populate("items.productId")
        .populate("items.variantId")
        .lean();
      if (order) amount = order.totalAmount;
    }

    res.render("user/pages/payment-success", {
      user: req.session.user,
      amount,
      order,
    });
  } catch (err) {
    res.render("user/pages/payment-success", {
      user: req.session.user,
      amount: 0,
      order: null,
    });
  }
};  

export const renderPaymentFailed = async (req, res) => {
  try {
    const { orderId } = req.query;
    let order = null;

    if (orderId) {
      order = await Order.findById(orderId)
        .populate("items.productId")
        .populate("items.variantId")
        .lean();
    }

    res.render("user/pages/payment-failed", { 
      user: req.session.user, 
      order 
    });
  } catch (err) {
    console.error("renderPaymentFailed error:", err);
    res.render("user/pages/payment-failed", { 
      user: req.session.user, 
      order: null 
    });
  }
};

async function getActiveOffers() {
  const now = new Date();
  return await Offer.find({
    isActive: true,
    isDeleted: false,
    startDate: { $lte: now },
    endDate: { $gte: now },
  }).lean();
}

function findBestOffer(product, activeOffers) {
  let bestOffer = null;
  for (const offer of activeOffers) {
    const sameProduct =
      offer.offerType === "product" &&
      String(offer.refId) === String(product._id);
    const sameCategory =
      offer.offerType === "category" &&
      String(offer.refId) === String(product.categoryId);
    if (sameProduct || sameCategory) {
      if (!bestOffer || offer.offerPrecentage > bestOffer.offerPrecentage) {
        bestOffer = offer;
      }
    }
  }
  return bestOffer;
}

async function getCartItems(cart) {
  const activeOffers = await getActiveOffers();
  const items = [];

  for (const cartItem of cart.items) {
    const product = await Product.findById(cartItem.productId)
      .select("productName images isActive isDeleted categoryId")
      .lean();
      console.log(product)

    const variant = await Variant.findById(cartItem.variantId)
      .select("price stock images options isActive isDeleted")
      .lean();

    if (!product || !variant) continue;

    const offerPct = findBestOffer(product, activeOffers)?.offerPrecentage ?? 0;
    const basePrice = variant.price;
    const salePrice =
      offerPct > 0 ? Math.round(basePrice * (1 - offerPct / 100)) : basePrice;

    items.push({
      productId: cartItem.productId,
      variantId: cartItem.variantId,
      quantity: cartItem.quantity,
      product: { ...product, name: product.productName },
      variant,
      image: variant.images?.[0] ?? product.images?.[0] ?? "",
      unitPrice: salePrice,
      originalPrice: basePrice,
      offerPct,
      lineTotal: salePrice * cartItem.quantity,
    });
  }

  return items;
}

async function checkStock(items) {
  for (const item of items) {
    const variant = await Variant.findById(item.variantId);
    if (
      !variant ||
      variant.isDeleted ||
      variant.isActive === false ||
      variant.stock < item.quantity
    ) {
      return { ok: false, name: item.product?.name || "Unknown" };
    }
  }
  return { ok: true };
}

async function deductStock(items) {//all or nothing if stock dousnot have deduction dousnot change all
  const deducted = [];
  for (const item of items) {
    const updated = await Variant.findOneAndUpdate(
      { _id: item.variantId, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity } },
      { returnDocument: "after" },
    );
    if (!updated) {
      for (const done of deducted) {
        await Variant.findByIdAndUpdate(done.variantId, {
          $inc: { stock: done.quantity },
        });
      }
      return { success: false };
    }
    deducted.push(item);
  }
  return { success: true };
}

function formatAddress(addr) {
  return {
    firstName: addr.firstName,
    lastName: addr.lastName,
    phone: addr.phone,
    email: addr.email,
    addressLine: addr.address,
    street: addr.street,
    state: addr.state,
    country: addr.country,
    pincode: addr.pincode,
  };
}

function buildOrderItems(cartItems, subtotal, totalCouponDiscount) {
  const orderItems = cartItems.map((item) => {
    const couponShare =
      subtotal > 0
        ? Math.round((item.lineTotal / subtotal) * totalCouponDiscount)
        : 0;
    return {
      productId: item.productId,
      variantId: item.variantId,
      productName: item.product.name,
      productImage: item.image || "",
      variantAttributes: item.variant.options,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      originalPrice: item.originalPrice || item.unitPrice,
      lineTotal: item.lineTotal,
      couponDiscount: couponShare,
      discountShare: couponShare,
      finalAmount: item.lineTotal - couponShare,
      finalPrice: item.lineTotal - couponShare,
      paidAmount: item.lineTotal - couponShare,
      status: "pending",
    };
  });

  //This code fixes tiny rounding errors
  //while splitting coupon discount among products.

  const distributed = orderItems.reduce((s, i) => s + i.couponDiscount, 0);
  const diff = totalCouponDiscount - distributed;
  if (diff !== 0 && orderItems.length > 0) {
    orderItems[orderItems.length - 1].couponDiscount += diff;
    orderItems[orderItems.length - 1].discountShare += diff;
    orderItems[orderItems.length - 1].finalAmount -= diff;
    orderItems[orderItems.length - 1].finalPrice -= diff;
    orderItems[orderItems.length - 1].paidAmount -= diff;
  }

  return orderItems;
}
