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

export const getWalletPage = async (req, res, next) => {
  try {
    const userId = req.session.user._id;
    const wallet = await getOrCreateWallet(userId);

    const pageNumber = Math.max(1, Number(req.query.page) || 1);
    const pageSize = 10;
    const skipTransactionsCount = (pageNumber - 1) * pageSize;

    const [transactions, totalCount] = await Promise.all([
      WalletTransaction.find({ walletId: wallet._id })
        .sort({ createdAt: -1 })
        .skip(skipTransactionsCount)
        .limit(pageSize)
        .lean(),
      WalletTransaction.countDocuments({ walletId: wallet._id }),
    ]);


    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    if (req.query.ajax === "1") {
      return res.json({
        success: true,
        balance: wallet.balance,
        transactions,
        currentPage: pageNumber,
        totalPages,
        totalCount,
      });
    }

    res.render("user/userProfile/wallet", {
      user: req.session.user,
      wallet,
      transactions,
      currentPage: pageNumber,
      totalPages,
      totalCount,
    });
  } catch (error) {
    next(error)
  }
};


export const createTopupOrder = async (req, res) => {
  try {
    const { amount } = req.body;
    const numericalAmount = Number(amount);

    console.log(numericalAmount)

    if (!numericalAmount || numericalAmount < 1) {
      return res.json({ success: false, message: "Minimum top-up is ₹1" });
    }
    if (numericalAmount > 50000) {
      return res.json({ success: false, message: "Maximum top-up is ₹50,000" });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(numericalAmount * 100),
      currency: "INR",
      receipt: `wallet_${req.session.user._id.toString().slice(-8)}_${Date.now().toString().slice(-8)}`,
    });

    req.session.pendingWalletTopup = {
      razorpayOrderId: razorpayOrder.id,
      amount: numericalAmount,
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

    console.log(razorpayOrderId,razorpayPaymentId, razorpaySignature)

    if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      return res.json({ success: false, message: "Payment verification data missing" });
    }

    const pendingTopupSession = req.session.pendingWalletTopup;
    if (!pendingTopupSession || pendingTopupSession.razorpayOrderId !== razorpayOrderId) {
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
      pendingTopupSession.amount,
      `Wallet top-up via Razorpay (${razorpayPaymentId})`,
      "wallet_topup"
    );

    delete req.session.pendingWalletTopup;

    return res.json({
      success: true,
      message: `₹${pendingTopupSession.amount.toLocaleString("en-IN")} added to your wallet!`,
      balance: wallet.balance,
    });
  } catch (error) {
    console.error("verifyTopup error:", error);
    res.status(500).json({ success: false, message: "Failed to verify payment" });
  }
};
