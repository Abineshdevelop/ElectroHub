import Razorpay from "razorpay";
import crypto from "crypto";
import Wallet from "../../model/walletModel.js";
import WalletTransaction from "../../model/walletTransactionModel.js";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

export async function getOrCreateWallet(userId) {
  let wallet = await Wallet.findOne({ userId });
  if (!wallet) {
    wallet = await Wallet.create({ userId, balance: 0 });
  }
  return wallet;
}

export async function creditWallet(userId, amount, description, reason = "order_refund", orderId = null) {
  const wallet = await getOrCreateWallet(userId);
  wallet.balance += amount;
  await wallet.save();

  await WalletTransaction.create({
    walletId: wallet._id,
    orderId,
    transactionType: "credit",
    amount,
    balanceAfter: wallet.balance,
    reason,
    referenceId: orderId,
    description,
  });

  return wallet;
}

export async function debitWallet(userId, amount, description, reason = "order_payment", orderId = null) {
  const wallet = await getOrCreateWallet(userId);
  if (wallet.balance < amount) {
    throw new Error(`Insufficient wallet balance. Available: ₹${wallet.balance}`);
  }
  wallet.balance -= amount;
  await wallet.save();

  await WalletTransaction.create({
    walletId: wallet._id,
    orderId,
    transactionType: "debit",
    amount,
    balanceAfter: wallet.balance,
    reason,
    referenceId: orderId,
    description,
  });

  return wallet;
}

export const getWalletPage = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const wallet = await getOrCreateWallet(userId);

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = 10;
    const skip = (page - 1) * limit;

    const [transactions, totalCount] = await Promise.all([
      WalletTransaction.find({ walletId: wallet._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WalletTransaction.countDocuments({ walletId: wallet._id }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / limit));

    if (req.query.ajax === "1") {
      return res.json({
        success: true,
        balance: wallet.balance,
        transactions,
        currentPage: page,
        totalPages,
        totalCount,
      });
    }

    res.render("user/userProfile/wallet", {
      user: req.session.user,
      wallet,
      transactions,
      currentPage: page,
      totalPages,
      totalCount,
    });
  } catch (error) {
    console.error("getWalletPage error:", error);
    res.status(500).render("error", { message: "Failed to load wallet" });
  }
};


export const createTopupOrder = async (req, res) => {
  try {
    const { amount } = req.body;
    const numAmount = Number(amount);

    if (!numAmount || numAmount < 1) {
      return res.json({ success: false, message: "Minimum top-up is ₹1" });
    }
    if (numAmount > 50000) {
      return res.json({ success: false, message: "Maximum top-up is ₹50,000" });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(numAmount * 100),
      currency: "INR",
      receipt: `wallet_${req.session.user._id.toString().slice(-8)}_${Date.now().toString().slice(-8)}`,
    });

    req.session.pendingWalletTopup = {
      razorpayOrderId: razorpayOrder.id,
      amount: numAmount,
    };

    return res.json({
      success: true,
      orderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("createTopupOrder error:", error);
    res.status(500).json({ success: false, message: "Failed to create payment order" });
  }
};


export const verifyTopup = async (req, res) => {
  try {
    const userId = req.session.user._id;
    const { razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body;

    if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      return res.json({ success: false, message: "Payment verification data missing" });
    }

    const pending = req.session.pendingWalletTopup;
    if (!pending || pending.razorpayOrderId !== razorpayOrderId) {
      return res.json({ success: false, message: "Invalid top-up session" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (expectedSignature !== razorpaySignature) {
      return res.json({ success: false, message: "Payment verification failed" });
    }

    const wallet = await creditWallet(
      userId,
      pending.amount,
      `Wallet top-up via Razorpay (${razorpayPaymentId})`,
      "wallet_topup"
    );

    delete req.session.pendingWalletTopup;

    return res.json({
      success: true,
      message: `₹${pending.amount.toLocaleString("en-IN")} added to your wallet!`,
      balance: wallet.balance,
    });
  } catch (error) {
    console.error("verifyTopup error:", error);
    res.status(500).json({ success: false, message: "Failed to verify payment" });
  }
};
